import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { MessageRecord } from "./types.js";
import { decodePayload, encodePayload, sleep, validateTopic } from "./utils.js";

export interface RecordInput {
  topic: string;
  payload: Buffer;
  qos?: number;
  retain?: boolean;
  clientId?: string;
  ts?: number;
}

export interface RecorderOptions {
  maxBytes?: number;
  onWarning?: (error: Error) => void;
}

export interface RecordingState {
  active: boolean;
  file: string | null;
  records: number;
  bytes: number;
  maxBytes: number;
  backpressured: boolean;
  dropped: number;
}

export const DEFAULT_MAX_RECORDING_BYTES = 100 * 1024 * 1024;
export const MAX_REPLAY_PAYLOAD_BYTES = 1024 * 1024;

export class NdjsonRecorder {
  private stream: WriteStream | null = null;
  private currentFile: string | null = null;
  private count = 0;
  private bytes = 0;
  private backpressured = false;
  private dropped = 0;
  private stopping: Promise<void> | null = null;
  private readonly maxBytes: number;
  private readonly onWarning: (error: Error) => void;

  constructor(options: RecorderOptions = {}) {
    const configuredMax = options.maxBytes ?? DEFAULT_MAX_RECORDING_BYTES;
    if (!Number.isSafeInteger(configuredMax) || configuredMax < 1) {
      throw new Error("Recording byte limit must be a positive safe integer.");
    }
    this.maxBytes = configuredMax;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  get state(): RecordingState {
    return {
      active: this.stream !== null,
      file: this.currentFile,
      records: this.count,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      backpressured: this.backpressured,
      dropped: this.dropped,
    };
  }

  async start(file: string): Promise<string> {
    if (this.stream) throw new Error("A recording is already active.");
    if (this.stopping) await this.stopping;
    const absolute = resolve(file);
    await mkdir(dirname(absolute), { recursive: true });
    const stream = createWriteStream(absolute, { flags: "a", encoding: "utf8" });
    await new Promise<void>((resolveOpen, reject) => {
      stream.once("open", () => resolveOpen());
      stream.once("error", reject);
    });
    this.stream = stream;
    this.currentFile = absolute;
    this.count = 0;
    this.bytes = 0;
    this.backpressured = false;
    this.dropped = 0;
    return absolute;
  }

  record(input: RecordInput): boolean {
    const stream = this.stream;
    if (!stream) return false;
    if (this.backpressured) {
      this.dropped += 1;
      return false;
    }
    const ts = input.ts ?? Date.now();
    const encoded = encodePayload(input.payload);
    const record: MessageRecord = {
      ts,
      iso: new Date(ts).toISOString(),
      topic: input.topic,
      ...encoded,
      qos: normalizeQos(input.qos),
      retain: input.retain === true,
      ...(input.clientId ? { clientId: input.clientId } : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.bytes + lineBytes > this.maxBytes) {
      this.dropped += 1;
      this.stopAtLimit();
      return false;
    }
    this.count += 1;
    this.bytes += lineBytes;
    const writable = stream.write(line);
    if (!writable) {
      this.backpressured = true;
      this.onWarning(new Error("Recording output is backpressured; messages are dropped until disk writes catch up."));
      stream.once("drain", () => {
        if (this.stream === stream) this.backpressured = false;
      });
    }
    if (this.bytes >= this.maxBytes) this.stopAtLimit();
    return writable;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stream = this.stream;
    this.stream = null;
    this.currentFile = null;
    this.backpressured = false;
    if (!stream) return;
    const stopping = new Promise<void>((resolveEnd, reject) => {
      stream.once("error", reject);
      stream.end(resolveEnd);
    });
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }

  private stopAtLimit(): void {
    if (!this.stream) return;
    this.onWarning(new Error(`Recording reached its ${this.maxBytes}-byte limit and was stopped.`));
    void this.stop().catch((error: unknown) => {
      this.onWarning(error instanceof Error ? error : new Error(String(error)));
    });
  }
}

export interface ReplayOptions {
  speed?: number;
  signal?: AbortSignal;
  onProgress?: (published: number, record: MessageRecord) => void;
  maxDelayMs?: number;
}

export type ReplayPublisher = (
  topic: string,
  payload: Buffer,
  options: { qos: 0 | 1 | 2; retain: boolean },
) => Promise<void>;

export async function replayNdjson(
  file: string,
  publish: ReplayPublisher,
  options: ReplayOptions = {},
): Promise<number> {
  const speed = Number(options.speed ?? 1);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 100) {
    throw new Error("Replay speed must be greater than 0 and no more than 100.");
  }
  const stream = createReadStream(resolve(file), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let previousTs: number | null = null;
  let published = 0;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      options.signal?.throwIfAborted();
      lineNumber += 1;
      if (!line.trim()) continue;
      if (line.length > 2_000_000) {
        throw new Error(`Recording line ${lineNumber} exceeds the 2 MB safety limit.`);
      }
      const record = parseRecord(line, lineNumber);
      if (record.topic.startsWith("$SYS/")) {
        throw new Error(`Recording line ${lineNumber} targets reserved $SYS topics.`);
      }
      const payload = decodePayload(record.payload, record.encoding);
      if (payload.length > MAX_REPLAY_PAYLOAD_BYTES) {
        throw new Error(`Recording line ${lineNumber} payload exceeds the 1 MiB replay limit.`);
      }
      if (previousTs !== null) {
        const delay = Math.max(0, record.ts - previousTs) / speed;
        await sleep(Math.min(delay, options.maxDelayMs ?? Number.POSITIVE_INFINITY), options.signal);
      }
      await publish(record.topic, payload, {
        qos: record.qos,
        retain: record.retain,
      });
      previousTs = record.ts;
      published += 1;
      options.onProgress?.(published, record);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return published;
}

function parseRecord(line: string, lineNumber: number): MessageRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Recording line ${lineNumber} is not valid JSON.`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Recording line ${lineNumber} must contain an object.`);
  }
  const candidate = value as Partial<MessageRecord>;
  const topic = validateTopic(candidate.topic);
  if (typeof candidate.payload !== "string") {
    throw new Error(`Recording line ${lineNumber} has no string payload.`);
  }
  if (candidate.payload.length > 2_000_000) {
    throw new Error(`Recording line ${lineNumber} payload exceeds the 2 MB safety limit.`);
  }
  if (candidate.encoding !== "utf8" && candidate.encoding !== "base64") {
    throw new Error(`Recording line ${lineNumber} has an invalid encoding.`);
  }
  const ts = Number(candidate.ts);
  if (!Number.isFinite(ts) || ts < 0) {
    throw new Error(`Recording line ${lineNumber} has an invalid timestamp.`);
  }
  return {
    ts,
    iso: typeof candidate.iso === "string" ? candidate.iso : new Date(ts).toISOString(),
    topic,
    payload: candidate.payload,
    encoding: candidate.encoding,
    qos: normalizeQos(candidate.qos),
    retain: candidate.retain === true,
    ...(typeof candidate.clientId === "string" ? { clientId: candidate.clientId } : {}),
  };
}

function normalizeQos(value: unknown): 0 | 1 | 2 {
  return value === 1 || value === 2 ? value : 0;
}
