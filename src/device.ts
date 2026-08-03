import { EventEmitter } from "node:events";
import mqtt, { type MqttClient } from "mqtt";
import type {
  DeviceOptions,
  DeviceSnapshot,
  DeviceType,
  FaultRequest,
} from "./types.js";
import {
  clamp,
  mulberry32,
  normalizeDeviceId,
  parsePositiveNumber,
  round,
} from "./utils.js";

export interface DeviceConnectionOptions {
  username?: string;
  password?: string;
}

interface ActiveFault {
  kind: FaultRequest["kind"];
  until?: number;
  jitterMs?: number;
  factor?: number;
  remaining?: number;
}

export class VirtualDevice extends EventEmitter {
  readonly id: string;
  readonly type: DeviceType;
  readonly seed: number;
  readonly intervalMs: number;
  readonly topic: string;
  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly random: () => number;
  private sequence = 0;
  private connected = false;
  private stopped = false;
  private fault: ActiveFault | null = null;
  private lastPayload: Record<string, unknown> | null = null;
  private energyKwh = 14.25;

  constructor(
    private readonly brokerUrl: string,
    options: DeviceOptions,
    private readonly connection: DeviceConnectionOptions = {},
  ) {
    super();
    this.id = normalizeDeviceId(options.id);
    this.type = options.type;
    this.seed = Math.trunc(parsePositiveNumber(options.seed, 42, 0, 0xffff_ffff));
    this.intervalMs = Math.trunc(parsePositiveNumber(options.intervalMs, 2_000, 100, 60_000));
    this.topic = `pocketlab/devices/${this.id}/telemetry`;
    this.random = mulberry32(this.seed);
  }

  start(): void {
    if (this.timer || this.client) return;
    this.stopped = false;
    this.connectClient();
    this.schedule(10);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (client.connected) {
      await new Promise<void>((resolve, reject) => {
        client.publish(
          `pocketlab/devices/${this.id}/status`,
          JSON.stringify({ online: false, deviceId: this.id, ts: new Date().toISOString() }),
          { qos: 1, retain: true },
          (publishError) => {
            if (publishError) return reject(publishError);
            client.end(false, {}, (endError) => endError ? reject(endError) : resolve());
          },
        );
      });
    } else {
      client.end(true);
    }
    this.connected = false;
    this.emit("changed", this.snapshot());
  }

  injectFault(request: FaultRequest): void {
    const durationMs = parsePositiveNumber(request.durationMs, 10_000, 200, 300_000);
    if (request.kind === "disconnect") {
      this.fault = { kind: "disconnect", until: Date.now() + durationMs };
      const client = this.client;
      this.client = null;
      this.connected = false;
      client?.end(true);
      setTimeout(() => {
        if (!this.stopped && this.fault?.kind === "disconnect") {
          this.fault = null;
          this.connectClient();
          this.emit("changed", this.snapshot());
        }
      }, durationMs).unref();
    } else if (request.kind === "jitter") {
      this.fault = {
        kind: "jitter",
        until: Date.now() + durationMs,
        jitterMs: parsePositiveNumber(request.jitterMs, 1_000, 50, 30_000),
      };
    } else {
      this.fault = {
        kind: "spike",
        factor: parsePositiveNumber(request.factor, 3, 1.1, 50),
        remaining: Math.trunc(parsePositiveNumber(request.readings, 3, 1, 100)),
      };
    }
    this.emit("changed", this.snapshot());
  }

  snapshot(): DeviceSnapshot {
    return {
      id: this.id,
      type: this.type,
      seed: this.seed,
      intervalMs: this.intervalMs,
      topic: this.topic,
      connected: this.connected,
      sequence: this.sequence,
      fault: this.fault?.kind ?? null,
      lastPayload: this.lastPayload,
    };
  }

  private connectClient(): void {
    if (this.stopped || this.client) return;
    const client = mqtt.connect(this.brokerUrl, {
      clientId: `pocketlab-${this.id}`,
      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 1_000,
      connectTimeout: 5_000,
      ...(this.connection.username ? { username: this.connection.username } : {}),
      ...(this.connection.password ? { password: this.connection.password } : {}),
    });
    this.client = client;
    client.on("connect", () => {
      this.connected = true;
      client.publish(
        `pocketlab/devices/${this.id}/status`,
        JSON.stringify({
          online: true,
          deviceId: this.id,
          type: this.type,
          seed: this.seed,
          ts: new Date().toISOString(),
        }),
        { qos: 1, retain: true },
      );
      this.emit("changed", this.snapshot());
    });
    client.on("close", () => {
      this.connected = false;
      this.emit("changed", this.snapshot());
    });
    client.on("error", (error) => this.emit("warning", error));
  }

  private schedule(delay = this.nextDelay()): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      this.schedule();
    }, delay);
    this.timer.unref();
  }

  private nextDelay(): number {
    if (this.fault?.kind === "jitter") {
      if ((this.fault.until ?? 0) <= Date.now()) {
        this.fault = null;
        this.emit("changed", this.snapshot());
      } else {
        const jitter = (this.random() * 2 - 1) * (this.fault.jitterMs ?? 0);
        return Math.max(50, this.intervalMs + jitter);
      }
    }
    return this.intervalMs;
  }

  private tick(): void {
    if (!this.client?.connected || this.fault?.kind === "disconnect") return;
    this.sequence += 1;
    const payload = this.createPayload();
    this.lastPayload = payload;
    this.client.publish(this.topic, JSON.stringify(payload), { qos: 0, retain: false });
    this.emit("telemetry", { topic: this.topic, payload });
    if (this.fault?.kind === "spike") {
      this.fault.remaining = (this.fault.remaining ?? 1) - 1;
      if (this.fault.remaining <= 0) {
        this.fault = null;
        this.emit("changed", this.snapshot());
      }
    }
  }

  private createPayload(): Record<string, unknown> {
    const noise = () => this.random() - 0.5;
    const factor = this.fault?.kind === "spike" ? (this.fault.factor ?? 3) : 1;
    const common = {
      deviceId: this.id,
      type: this.type,
      sequence: this.sequence,
      ts: new Date().toISOString(),
      fault: this.fault?.kind ?? null,
    };
    if (this.type === "climate") {
      const temperature = (22 + Math.sin(this.sequence / 12) * 2 + noise() * 0.6) * factor;
      const humidity = (52 + Math.sin(this.sequence / 17 + 1) * 8 + noise() * 1.8) * factor;
      return {
        ...common,
        temperatureC: round(temperature),
        humidityPct: round(clamp(humidity, 0, 100)),
        batteryPct: round(Math.max(5, 98 - this.sequence * 0.002), 2),
      };
    }
    if (this.type === "co2") {
      const co2 = (540 + Math.sin(this.sequence / 8) * 90 + noise() * 25) * factor;
      return {
        ...common,
        co2Ppm: Math.round(Math.max(350, co2)),
        tvocPpb: Math.round(Math.max(0, (70 + noise() * 20) * factor)),
        temperatureC: round(23 + noise()),
      };
    }
    const voltage = 230 + Math.sin(this.sequence / 10) * 2 + noise();
    const current = Math.max(0.1, (2.4 + Math.sin(this.sequence / 5) * 1.1 + noise() * 0.2) * factor);
    const power = voltage * current * 0.92;
    this.energyKwh += (power * this.intervalMs) / 3_600_000_000;
    return {
      ...common,
      voltageV: round(voltage),
      currentA: round(current, 2),
      activePowerW: round(power),
      energyKwh: round(this.energyKwh, 4),
      frequencyHz: round(50 + noise() * 0.04, 2),
    };
  }
}

export class DeviceManager extends EventEmitter {
  private readonly devices = new Map<string, VirtualDevice>();

  constructor(
    private readonly brokerUrl: string,
    private readonly connection: DeviceConnectionOptions = {},
  ) {
    super();
  }

  start(options: DeviceOptions): DeviceSnapshot {
    normalizeDeviceId(options.id);
    if (!(["climate", "co2", "meter"] as string[]).includes(options.type)) {
      throw new Error(`Unknown device type: ${String(options.type)}`);
    }
    if (this.devices.has(options.id)) {
      throw new Error(`Device '${options.id}' is already running.`);
    }
    const device = new VirtualDevice(this.brokerUrl, options, this.connection);
    this.devices.set(device.id, device);
    device.on("changed", (snapshot) => this.emit("changed", snapshot));
    device.on("telemetry", (message) => this.emit("telemetry", message));
    device.on("warning", (error) => this.emit("warning", error));
    device.start();
    this.emit("changed", device.snapshot());
    return device.snapshot();
  }

  async stop(id: string): Promise<void> {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Device '${id}' was not found.`);
    this.devices.delete(id);
    await device.stop();
    this.emit("removed", { id });
  }

  injectFault(id: string, request: FaultRequest): DeviceSnapshot {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Device '${id}' was not found.`);
    if (!(["disconnect", "jitter", "spike"] as string[]).includes(request.kind)) {
      throw new Error(`Unknown fault: ${String(request.kind)}`);
    }
    device.injectFault(request);
    return device.snapshot();
  }

  snapshots(): DeviceSnapshot[] {
    return [...this.devices.values()].map((device) => device.snapshot());
  }

  async stopAll(): Promise<void> {
    const devices = [...this.devices.values()];
    this.devices.clear();
    await Promise.all(devices.map((device) => device.stop()));
  }
}
