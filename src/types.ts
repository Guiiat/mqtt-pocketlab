export type DeviceType = "climate" | "co2" | "meter";

export type FaultKind = "disconnect" | "jitter" | "spike";

export interface DeviceOptions {
  type: DeviceType;
  id: string;
  seed?: number;
  intervalMs?: number;
}

export interface FaultRequest {
  kind: FaultKind;
  durationMs?: number;
  jitterMs?: number;
  factor?: number;
  readings?: number;
}

export interface DeviceSnapshot {
  id: string;
  type: DeviceType;
  seed: number;
  intervalMs: number;
  topic: string;
  connected: boolean;
  sequence: number;
  fault: FaultKind | null;
  lastPayload: Record<string, unknown> | null;
}

export interface MessageRecord {
  ts: number;
  iso: string;
  topic: string;
  payload: string;
  encoding: "utf8" | "base64";
  qos: 0 | 1 | 2;
  retain: boolean;
  clientId?: string;
}

export interface TopicSnapshot {
  topic: string;
  payload: string;
  encoding: "utf8" | "base64";
  qos: number;
  retain: boolean;
  clientId: string | null;
  updatedAt: number;
  messages: number;
  bytes: number;
}

export interface ClientSnapshot {
  id: string;
  connectedAt: number;
}

export interface ThroughputSnapshot {
  messageRate: number;
  byteRate: number;
  totalMessages: number;
  totalBytes: number;
}

export interface LabState {
  name: string;
  version: string;
  startedAt: number;
  uptimeMs: number;
  mqttUrl: string;
  webUrl: string;
  mqttPort: number;
  webPort: number;
  localOnly: boolean;
  clients: ClientSnapshot[];
  topics: TopicSnapshot[];
  recentMessages: MessageRecord[];
  throughput: ThroughputSnapshot;
  devices: DeviceSnapshot[];
  recording: {
    active: boolean;
    file: string | null;
    records: number;
    bytes: number;
    maxBytes: number;
    backpressured: boolean;
    dropped: number;
  };
  replay: { active: boolean; file: string | null; published: number };
}
