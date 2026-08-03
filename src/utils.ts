import { isUtf8 } from "node:buffer";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Sleep duration must be finite.");
  }
  let remaining = Math.max(0, milliseconds);
  while (remaining > 0) {
    signal?.throwIfAborted();
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await sleepChunk(delay, signal);
    remaining -= delay;
  }
}

function sleepChunk(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(
      signal?.reason instanceof Error ? signal.reason : new Error("Aborted"),
    );
    timeout = setTimeout(() => finish(), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function encodePayload(buffer: Buffer): Pick<
  import("./types.js").MessageRecord,
  "payload" | "encoding"
> {
  if (isUtf8(buffer)) {
    return { payload: buffer.toString("utf8"), encoding: "utf8" };
  }
  return { payload: buffer.toString("base64"), encoding: "base64" };
}

export function decodePayload(payload: string, encoding: "utf8" | "base64"): Buffer {
  return Buffer.from(payload, encoding === "base64" ? "base64" : "utf8");
}

export function isLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function validateTopic(topic: unknown): string {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 65_535) {
    throw new Error("Topic must be a non-empty string no longer than 65,535 characters.");
  }
  if (topic.includes("#") || topic.includes("+") || topic.includes("\0")) {
    throw new Error("Publish topics cannot contain #, +, or null characters.");
  }
  if (topic.split("/").length > 16) {
    throw new Error("Topics cannot contain more than 16 levels.");
  }
  return topic;
}

export function normalizeDeviceId(input: unknown): string {
  if (typeof input !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(input)) {
    throw new Error("Device id must be 1-48 letters, numbers, underscores, or dashes.");
  }
  return input;
}

export function parsePositiveNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactUrlCredentials(stripTerminalControls(message));
}

export function redactUrlCredentials(value: string): string {
  return value.replace(
    /\b(?:https?|mqtts?|wss?):\/\/[^\s<>"']+/gi,
    (candidate) => {
      try {
        const url = new URL(candidate);
        if (url.username !== "") url.username = "***";
        if (url.password !== "") url.password = "***";
        return url.toString().replaceAll("%2A%2A%2A", "***");
      } catch {
        return candidate.replace(/(:\/\/)[^/@\s]+@/, "$1***:***@");
      }
    },
  );
}

export function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
}
