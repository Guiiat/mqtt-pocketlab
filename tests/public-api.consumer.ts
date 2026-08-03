import {
  DEFAULT_MAX_RECORDING_BYTES,
  DeviceManager,
  NdjsonRecorder,
  PocketLab,
  VirtualDevice,
  getScenario,
  limits,
  replayNdjson,
  scenarios,
} from "mqtt-pocketlab";
import type {
  DeviceConnectionOptions,
  DeviceOptions,
  DeviceSnapshot,
  DeviceType,
  FaultKind,
  FaultRequest,
  LabState,
  MessageRecord,
  PocketLabOptions,
  RecorderOptions,
  RecordingState,
  RecordInput,
  ReplayOptions,
  ReplayPublisher,
  Scenario,
} from "mqtt-pocketlab";

const labOptions: PocketLabOptions = { mqttPort: 0, webPort: 0 };
const recorderOptions: RecorderOptions = { maxBytes: DEFAULT_MAX_RECORDING_BYTES };
const connection: DeviceConnectionOptions = {};
const deviceOptions: DeviceOptions = { type: "climate", id: "consumer" };
const scenario: Scenario | undefined = getScenario("smart-home");
const publisher: ReplayPublisher = async () => undefined;
const replayOptions: ReplayOptions = { speed: 2 };
const record: RecordInput = { topic: "consumer/test", payload: Buffer.from("ok") };
const recorderState: RecordingState = new NdjsonRecorder(recorderOptions).state;

const publicValues: readonly unknown[] = [
  PocketLab,
  DeviceManager,
  VirtualDevice,
  replayNdjson,
  scenarios,
  limits,
  labOptions,
  connection,
  deviceOptions,
  scenario,
  publisher,
  replayOptions,
  record,
  recorderState,
];
void publicValues;

type PublicTypes =
  | DeviceSnapshot
  | DeviceType
  | FaultKind
  | FaultRequest
  | LabState
  | MessageRecord;
void (undefined as PublicTypes | undefined);
