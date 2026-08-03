import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { type Server as HttpServer } from "node:http";
import { createServer, isIP, type Server as TcpServer, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Aedes, type AedesPublishPacket, type Client, type PublishPacket } from "aedes";
import { DeviceManager } from "./device.js";
import {
  DEFAULT_MAX_RECORDING_BYTES,
  NdjsonRecorder,
  replayNdjson,
} from "./recording.js";
import { getScenario, scenarios } from "./scenarios.js";
import type {
  FaultRequest,
  LabState,
  MessageRecord,
  TopicSnapshot,
} from "./types.js";
import {
  encodePayload,
  errorMessage,
  isLoopback,
  parsePositiveNumber,
  validateTopic,
} from "./utils.js";

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_PREVIEW_BYTES = 8_192;
const MAX_TOPICS = 500;
const MAX_RECENT_MESSAGES = 100;
const MAX_SSE_CLIENTS = 32;

export interface PocketLabOptions {
  host?: string;
  mqttPort?: number;
  webPort?: number;
  username?: string;
  password?: string;
  recordingDirectory?: string;
  maxRecordingBytes?: number;
  advertiseHost?: string;
}

interface ReplayState {
  active: boolean;
  file: string | null;
  published: number;
}

export class PocketLab {
  readonly host: string;
  mqttPort: number;
  webPort: number;
  readonly localOnly: boolean;
  private broker: Aedes | null = null;
  private mqttServer: TcpServer | null = null;
  private readonly mqttSockets = new Set<Socket>();
  private httpServer: HttpServer | null = null;
  private deviceManager: DeviceManager | null = null;
  private readonly recorder: NdjsonRecorder;
  private readonly topics = new Map<string, TopicSnapshot>();
  private readonly clients = new Map<string, number>();
  private readonly recentMessages: MessageRecord[] = [];
  private readonly sseClients = new Set<Response>();
  private startedAt = 0;
  private totalMessages = 0;
  private totalBytes = 0;
  private currentSecondMessages = 0;
  private currentSecondBytes = 0;
  private messageRate = 0;
  private byteRate = 0;
  private metricsTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private replay: ReplayState = { active: false, file: null, published: 0 };
  private replayAbort: AbortController | null = null;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly recordingDirectory: string;
  private readonly advertiseHost: string | undefined;

  constructor(options: PocketLabOptions = {}) {
    this.host = options.host?.trim() || "127.0.0.1";
    this.mqttPort = normalizePort(options.mqttPort, 1883);
    this.webPort = normalizePort(options.webPort, 3000);
    this.localOnly = isLoopback(this.host);
    this.username = options.username;
    this.password = options.password;
    this.advertiseHost = options.advertiseHost === undefined
      ? undefined
      : normalizeAdvertiseHost(options.advertiseHost);
    this.recordingDirectory = resolve(options.recordingDirectory ?? "recordings");
    this.recorder = new NdjsonRecorder({
      maxBytes: options.maxRecordingBytes ?? DEFAULT_MAX_RECORDING_BYTES,
      onWarning: (error) => this.broadcast("warning", { message: errorMessage(error) }),
    });
    if (this.localOnly && this.advertiseHost !== undefined) {
      throw new Error("Advertise host is only supported for non-loopback bindings.");
    }
    if (!this.localOnly && (!this.username || !this.password)) {
      throw new Error(
        "Remote binding requires both a username and password. Prefer the default 127.0.0.1 binding.",
      );
    }
  }

  get mqttUrl(): string {
    return `mqtt://${displayHost(this.advertiseHost ?? this.host)}:${this.mqttPort}`;
  }

  get webUrl(): string {
    return `http://${displayHost(this.advertiseHost ?? this.host)}:${this.webPort}`;
  }

  async start(): Promise<this> {
    if (this.broker) throw new Error("MQTT PocketLab is already running.");
    const broker = await Aedes.createBroker({
      id: "mqtt-pocketlab",
      concurrency: 100,
      queueLimit: 100,
      connectTimeout: 10_000,
      drainTimeout: 30_000,
      keepaliveLimit: 300,
      maxClientsIdLength: 64,
      maxTopicLevels: 16,
      authenticate: (_client, username, password, done) => {
        if (this.localOnly) return done(null, true);
        const suppliedUser = username ?? "";
        const suppliedPassword = password?.toString("utf8") ?? "";
        done(null, safeEqual(suppliedUser, this.username ?? "") && safeEqual(suppliedPassword, this.password ?? ""));
      },
      authorizePublish: (_client, packet, callback) => {
        if (packet.topic.startsWith("$SYS/")) {
          callback(new Error("Publishing to $SYS topics is reserved for the broker."));
          return;
        }
        if (packet.payload.length > MAX_PAYLOAD_BYTES) {
          callback(new Error("Payload exceeds MQTT PocketLab's 1 MiB limit."));
          return;
        }
        callback(null);
      },
    });
    this.broker = broker;
    this.attachBrokerEvents(broker);
    const mqttServer = createServer((socket) => {
      this.mqttSockets.add(socket);
      socket.once("close", () => this.mqttSockets.delete(socket));
      broker.handle(socket);
    });
    mqttServer.maxConnections = 1_000;
    this.mqttServer = mqttServer;
    try {
      await listen(mqttServer, this.mqttPort, this.host);
      this.mqttPort = serverPort(mqttServer);
      const simulatorHost = simulatorHostForBinding(this.host);
      this.deviceManager = new DeviceManager(
        `mqtt://${displayHost(simulatorHost)}:${this.mqttPort}`,
        {
          ...(this.username ? { username: this.username } : {}),
          ...(this.password ? { password: this.password } : {}),
        },
      );
      this.attachDeviceEvents(this.deviceManager);
      const app = this.createWebApp();
      this.httpServer = await listenExpress(app, this.webPort, this.host);
      this.webPort = serverPort(this.httpServer);
      this.startedAt = Date.now();
      this.startTimers();
      this.broadcast("ready", this.state());
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.replayAbort?.abort(new Error("PocketLab stopped."));
    this.replayAbort = null;
    await this.recorder.stop();
    await this.deviceManager?.stopAll();
    this.deviceManager = null;
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.metricsTimer = null;
    this.heartbeatTimer = null;
    for (const response of this.sseClients) response.end();
    this.sseClients.clear();
    const httpServer = this.httpServer;
    this.httpServer = null;
    if (httpServer) await closeServer(httpServer);
    const mqttServer = this.mqttServer;
    this.mqttServer = null;
    if (mqttServer) {
      const closed = closeServer(mqttServer);
      for (const socket of this.mqttSockets) socket.destroy();
      this.mqttSockets.clear();
      await closed;
    }
    const broker = this.broker;
    this.broker = null;
    if (broker && !broker.closed) {
      await new Promise<void>((resolveClose) => broker.close(resolveClose));
    }
    this.clients.clear();
  }

  state(): LabState {
    const recording = this.recorder.state;
    return {
      name: "MQTT PocketLab",
      version: "0.1.0",
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      mqttUrl: this.mqttUrl,
      webUrl: this.webUrl,
      mqttPort: this.mqttPort,
      webPort: this.webPort,
      localOnly: this.localOnly,
      clients: [...this.clients.entries()].map(([id, connectedAt]) => ({ id, connectedAt })),
      topics: [...this.topics.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      recentMessages: [...this.recentMessages],
      throughput: {
        messageRate: this.messageRate,
        byteRate: this.byteRate,
        totalMessages: this.totalMessages,
        totalBytes: this.totalBytes,
      },
      devices: this.deviceManager?.snapshots() ?? [],
      recording: {
        ...recording,
        file: recording.file === null ? null : basename(recording.file),
      },
      replay: this.publicReplayState(),
    };
  }

  async startScenario(id: string): Promise<void> {
    const scenario = getScenario(id);
    if (!scenario) throw new Error(`Unknown scenario '${id}'.`);
    const manager = this.requireDevices();
    const existing = new Set(manager.snapshots().map((device) => device.id));
    const duplicate = scenario.devices.find((device) => existing.has(device.id));
    if (duplicate) throw new Error(`Scenario device '${duplicate.id}' is already running.`);
    for (const device of scenario.devices) manager.start(device);
  }

  startDevice(options: import("./types.js").DeviceOptions): import("./types.js").DeviceSnapshot {
    return this.requireDevices().start(options);
  }

  async startRecording(file: string): Promise<string> {
    const absolute = await this.recorder.start(file);
    this.broadcast("recording", this.state().recording);
    return absolute;
  }

  async stopRecording(): Promise<void> {
    await this.recorder.stop();
    this.broadcast("recording", this.state().recording);
  }

  private createWebApp(): express.Express {
    const app = express();
    app.disable("x-powered-by");
    app.use((request, response, next) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
      );
      if (!this.checkRequestHost(request)) {
        response.status(403).json({ error: "Request Host is not allowed for this PocketLab listener." });
        return;
      }
      if (isMutationMethod(request.method)) {
        if (!request.is("application/json")) {
          response.status(415).json({ error: "Mutation APIs require Content-Type: application/json." });
          return;
        }
        if (!this.checkMutationOrigin(request)) {
          response.status(403).json({ error: "Mutation APIs require a same-origin request." });
          return;
        }
      }
      if (this.localOnly || this.checkHttpAuthentication(request)) return next();
      response.setHeader("WWW-Authenticate", 'Basic realm="MQTT PocketLab"');
      response.status(401).send("Authentication required.");
    });
    app.use(express.json({ limit: "1mb", strict: true }));

    app.get("/api/state", (_request, response) => response.json(this.state()));
    app.get("/api/scenarios", (_request, response) => response.json(scenarios));
    app.get("/api/events", (request, response) => {
      if (this.sseClients.size >= MAX_SSE_CLIENTS) {
        response.status(503).json({ error: `SSE client limit (${MAX_SSE_CLIENTS}) reached.` });
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();
      this.sseClients.add(response);
      this.writeEvent(response, "snapshot", this.state());
      request.on("close", () => this.sseClients.delete(response));
    });
    app.post("/api/publish", this.asyncRoute(async (request, response) => {
      const topic = validateTopic(request.body?.topic);
      if (topic.startsWith("$SYS/")) throw new Error("Publishing to $SYS topics is reserved.");
      const payload = typeof request.body?.payload === "string" ? request.body.payload : JSON.stringify(request.body?.payload ?? "");
      const buffer = Buffer.from(payload, "utf8");
      if (buffer.length > MAX_PAYLOAD_BYTES) throw new Error("Payload exceeds the 1 MiB limit.");
      const qos = normalizeQos(request.body?.qos);
      await this.publish(topic, buffer, { qos, retain: request.body?.retain === true });
      response.status(202).json({ ok: true });
    }));
    app.post("/api/devices", this.asyncRoute(async (request, response) => {
      const snapshot = this.requireDevices().start({
        type: request.body?.type,
        id: request.body?.id,
        seed: request.body?.seed,
        intervalMs: request.body?.intervalMs,
      });
      response.status(201).json(snapshot);
    }));
    app.delete("/api/devices/:id", this.asyncRoute(async (request, response) => {
      await this.requireDevices().stop(singleParam(request.params.id));
      response.status(204).end();
    }));
    app.post("/api/devices/:id/fault", this.asyncRoute(async (request, response) => {
      const fault = this.requireDevices().injectFault(singleParam(request.params.id), request.body as FaultRequest);
      response.status(202).json(fault);
    }));
    app.post("/api/scenarios/:id/start", this.asyncRoute(async (request, response) => {
      await this.startScenario(singleParam(request.params.id));
      response.status(202).json({ ok: true });
    }));
    app.post("/api/recording/start", this.asyncRoute(async (request, response) => {
      if (this.replay.active) throw new Error("A replay is already active; stop it before recording.");
      const file = this.recordingFile(request.body?.file);
      await this.recorder.start(file);
      this.broadcast("recording", this.state().recording);
      response.status(201).json(this.state().recording);
    }));
    app.post("/api/recording/stop", this.asyncRoute(async (_request, response) => {
      await this.recorder.stop();
      this.broadcast("recording", this.state().recording);
      response.json(this.state().recording);
    }));
    app.post("/api/replay/start", this.asyncRoute(async (request, response) => {
      if (this.replay.active) throw new Error("A replay is already active.");
      if (this.recorder.state.active) throw new Error("A recording is already active; stop it before replaying.");
      const file = this.recordingFile(request.body?.file);
      const speed = parsePositiveNumber(request.body?.speed, 1, 0.05, 100);
      this.startReplay(file, speed);
      response.status(202).json({ ...this.replay });
    }));
    app.post("/api/replay/stop", (_request, response) => {
      this.replayAbort?.abort(new Error("Replay stopped."));
      response.status(202).json({ ok: true });
    });
    app.get("/health", (_request, response) => response.json({ status: "ok", broker: Boolean(this.broker) }));

    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const staticDirectory = resolve(moduleDirectory, "../web");
    app.use(express.static(staticDirectory, { etag: true, maxAge: "1h", index: "index.html" }));
    app.use((_request, response) => response.status(404).json({ error: "Not found." }));
    app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      const message = errorMessage(error);
      response.status(message.includes("already") ? 409 : 400).json({ error: message });
    });
    return app;
  }

  private attachBrokerEvents(broker: Aedes): void {
    broker.on("clientReady", (client: Client) => {
      this.clients.set(client.id, Date.now());
      this.broadcast("client-connected", { id: client.id });
    });
    broker.on("clientDisconnect", (client: Client) => {
      this.clients.delete(client.id);
      this.broadcast("client-disconnected", { id: client.id });
    });
    broker.on("clientError", (client, error) => {
      this.broadcast("warning", { clientId: client.id, message: errorMessage(error) });
    });
    broker.on("connectionError", (client, error) => {
      this.broadcast("warning", { clientId: client.id || "unknown", message: errorMessage(error) });
    });
    broker.on("publish", (packet: AedesPublishPacket, client: Client | null) => {
      if (packet.topic.startsWith("$SYS/")) return;
      this.observeMessage(packet, client);
    });
  }

  private observeMessage(packet: AedesPublishPacket, client: Client | null): void {
    const originalPayload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    const size = originalPayload.length;
    this.totalMessages += 1;
    this.totalBytes += size;
    this.currentSecondMessages += 1;
    this.currentSecondBytes += size;
    if (size <= MAX_PAYLOAD_BYTES) {
      this.recorder.record({
        topic: packet.topic,
        payload: originalPayload,
        qos: packet.qos,
        retain: packet.retain,
        ...(client?.id ? { clientId: client.id } : {}),
      });
    }
    const previewBuffer = originalPayload.subarray(0, MAX_PREVIEW_BYTES);
    const encoded = encodePayload(previewBuffer);
    const preview = size > MAX_PREVIEW_BYTES
      ? { ...encoded, payload: `${encoded.payload}… [${size - MAX_PREVIEW_BYTES} more bytes]` }
      : encoded;
    const now = Date.now();
    const existing = this.topics.get(packet.topic);
    const topic: TopicSnapshot = {
      topic: packet.topic,
      ...preview,
      qos: packet.qos,
      retain: packet.retain === true,
      clientId: client?.id ?? null,
      updatedAt: now,
      messages: (existing?.messages ?? 0) + 1,
      bytes: (existing?.bytes ?? 0) + size,
    };
    if (!existing && this.topics.size >= MAX_TOPICS) {
      const oldest = [...this.topics.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest) this.topics.delete(oldest.topic);
    }
    this.topics.set(packet.topic, topic);
    const record: MessageRecord = {
      ts: now,
      iso: new Date(now).toISOString(),
      topic: packet.topic,
      ...preview,
      qos: normalizeQos(packet.qos),
      retain: packet.retain === true,
      ...(client?.id ? { clientId: client.id } : {}),
    };
    this.recentMessages.unshift(record);
    if (this.recentMessages.length > MAX_RECENT_MESSAGES) this.recentMessages.length = MAX_RECENT_MESSAGES;
    this.broadcast("message", record);
  }

  private attachDeviceEvents(manager: DeviceManager): void {
    manager.on("changed", (device) => this.broadcast("device-changed", device));
    manager.on("removed", (device) => this.broadcast("device-removed", device));
    manager.on("warning", (error: unknown) => this.broadcast("warning", { message: errorMessage(error) }));
  }

  private startTimers(): void {
    this.metricsTimer = setInterval(() => {
      this.messageRate = this.currentSecondMessages;
      this.byteRate = this.currentSecondBytes;
      this.currentSecondMessages = 0;
      this.currentSecondBytes = 0;
      this.broadcast("metrics", this.state().throughput);
    }, 1_000);
    this.metricsTimer.unref();
    this.heartbeatTimer = setInterval(() => {
      for (const response of this.sseClients) this.writeSse(response, ": heartbeat\n\n");
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  private async publish(
    topic: string,
    payload: Buffer,
    options: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<void> {
    const broker = this.broker;
    if (!broker) throw new Error("Broker is not running.");
    validateTopic(topic);
    if (topic.startsWith("$SYS/")) throw new Error("Publishing to $SYS topics is reserved for the broker.");
    if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("Payload exceeds MQTT PocketLab's 1 MiB limit.");
    const packet: PublishPacket = { cmd: "publish", topic, payload, ...options, dup: false };
    await new Promise<void>((resolvePublish, reject) => {
      broker.publish(packet, (error) => error ? reject(error) : resolvePublish());
    });
  }

  private startReplay(file: string, speed: number): void {
    const abort = new AbortController();
    this.replayAbort = abort;
    this.replay = { active: true, file, published: 0 };
    this.broadcast("replay", this.publicReplayState());
    void replayNdjson(
      file,
      (topic, payload, options) => this.publish(topic, payload, options),
      {
        speed,
        signal: abort.signal,
        onProgress: (published) => {
          this.replay.published = published;
          if (published % 10 === 0) this.broadcast("replay", this.publicReplayState());
        },
      },
    ).then(
      () => this.finishReplay(),
      (error: unknown) => {
        if (!abort.signal.aborted) this.broadcast("warning", { message: errorMessage(error) });
        this.finishReplay();
      },
    );
  }

  private finishReplay(): void {
    this.replay = { ...this.replay, active: false };
    this.replayAbort = null;
    this.broadcast("replay", this.publicReplayState());
  }

  private recordingFile(input: unknown): string {
    const name = typeof input === "string" ? input.trim() : "";
    if (!name) throw new Error("Choose a recording file.");
    if (basename(name) !== name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.ndjson$/.test(name)) {
      throw new Error("Recording file must be a simple .ndjson filename without directories.");
    }
    return join(this.recordingDirectory, name);
  }

  private requireDevices(): DeviceManager {
    if (!this.deviceManager) throw new Error("Device manager is not running.");
    return this.deviceManager;
  }

  private broadcast(type: string, data: unknown): void {
    for (const response of this.sseClients) this.writeEvent(response, type, data);
  }

  private writeEvent(response: Response, type: string, data: unknown): void {
    this.writeSse(
      response,
      `event: lab\ndata: ${JSON.stringify({ type, at: Date.now(), data })}\n\n`,
    );
  }

  private writeSse(response: Response, payload: string): void {
    if (writeSseChunk(response, payload)) return;
    this.sseClients.delete(response);
  }

  private publicReplayState(): ReplayState {
    return {
      ...this.replay,
      file: this.replay.file === null ? null : basename(this.replay.file),
    };
  }

  private checkRequestHost(request: Request): boolean {
    const authority = parseAuthority(request.headers.host);
    if (!authority || authority.port !== this.webPort) return false;
    const requestedHost = normalizeHostForComparison(authority.hostname);
    if (this.localOnly) {
      return requestedHost === normalizeHostForComparison(this.host);
    }
    if (isWildcardHost(this.host)) {
      const expected = this.advertiseHost ?? request.socket.localAddress;
      return expected !== undefined && requestedHost === normalizeHostForComparison(expected);
    }
    return [this.host, this.advertiseHost]
      .filter((host): host is string => host !== undefined)
      .some((host) => requestedHost === normalizeHostForComparison(host));
  }

  private checkMutationOrigin(request: Request): boolean {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin);
        const originAuthority = parseAuthority(parsed.host);
        const requestAuthority = parseAuthority(request.headers.host);
        return parsed.protocol === "http:" &&
          originAuthority !== null &&
          requestAuthority !== null &&
          originAuthority.port === requestAuthority.port &&
          normalizeHostForComparison(originAuthority.hostname) ===
            normalizeHostForComparison(requestAuthority.hostname);
      } catch {
        return false;
      }
    }
    const fetchSite = request.headers["sec-fetch-site"];
    return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
  }

  private checkHttpAuthentication(request: Request): boolean {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Basic ")) return false;
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
      const password = separator >= 0 ? decoded.slice(separator + 1) : "";
      return safeEqual(username, this.username ?? "") && safeEqual(password, this.password ?? "");
    } catch {
      return false;
    }
  }

  private asyncRoute(
    handler: (request: Request, response: Response) => Promise<void>,
  ): (request: Request, response: Response, next: NextFunction) => void {
    return (request, response, next) => void handler(request, response).catch(next);
  }
}

export function writeSseChunk(
  response: Pick<Response, "write" | "end">,
  payload: string,
): boolean {
  if (response.write(payload)) return true;
  response.end();
  return false;
}

function normalizePort(value: unknown, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${String(value)}`);
  return port;
}

function normalizeQos(value: unknown): 0 | 1 | 2 {
  const parsed = Number(value);
  return parsed === 1 || parsed === 2 ? parsed : 0;
}

function displayHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function simulatorHostForBinding(host: string): string {
  const normalized = normalizeHostForComparison(host);
  if (normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "::") return "::1";
  return host;
}

function normalizeAdvertiseHost(input: string): string {
  const host = input.trim().replace(/^\[|\]$/g, "");
  if (
    host === "" ||
    /[\s/@?#]/.test(host) ||
    (isIP(host) === 0 && !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?))*$/i.test(host))
  ) {
    throw new Error("Advertise host must be a hostname or IP address without a scheme or port.");
  }
  return host;
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHostForComparison(host);
  return normalized === "0.0.0.0" || normalized === "::";
}

function normalizeHostForComparison(host: string): string {
  const unwrapped = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return unwrapped.startsWith("::ffff:") ? unwrapped.slice(7) : unwrapped;
}

function parseAuthority(input: string | undefined): { hostname: string; port: number } | null {
  if (!input || /[\s/@?#]/.test(input)) return null;
  try {
    const parsed = new URL(`http://${input}`);
    const port = parsed.port === "" ? 80 : Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { hostname: parsed.hostname, port };
  } catch {
    return null;
  }
}

function isMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function listen(server: TcpServer, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function listenExpress(app: express.Express, port: number, host: string): Promise<HttpServer> {
  return new Promise((resolveListen, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolveListen(server));
    server.once("error", reject);
  });
}

function serverPort(server: TcpServer | HttpServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve listening port.");
  return address.port;
}

function closeServer(server: TcpServer | HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export const limits = {
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  maxPreviewBytes: MAX_PREVIEW_BYTES,
  maxTopics: MAX_TOPICS,
  maxSseClients: MAX_SSE_CLIENTS,
  defaultMaxRecordingBytes: DEFAULT_MAX_RECORDING_BYTES,
} as const;
