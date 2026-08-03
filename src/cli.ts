#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import mqtt, { type MqttClient } from "mqtt";
import { VirtualDevice } from "./device.js";
import { PocketLab } from "./lab.js";
import { NdjsonRecorder, replayNdjson } from "./recording.js";
import { scenarios } from "./scenarios.js";
import type { DeviceType } from "./types.js";
import { errorMessage, isLoopback, redactUrlCredentials } from "./utils.js";

const program = new Command();

program
  .name("mqtt-pocketlab")
  .description("Local-first MQTT broker, observability console, simulator, recorder, and replay tool")
  .version("0.1.0")
  .showHelpAfterError();

program
  .command("start", { isDefault: true })
  .description("Start the embedded MQTT broker and web console")
  .option("--host <host>", "listen address (remote binding requires --allow-remote and credentials)", "127.0.0.1")
  .option("--mqtt-port <port>", "MQTT TCP port", parsePort, 1883)
  .option("--web-port <port>", "web console port", parsePort, 3000)
  .option("--scenario <id>", "start a built-in scenario")
  .option("--record <file>", "record all MQTT traffic to an NDJSON file")
  .option("--max-recording-mib <mib>", "recording size limit in MiB", parseRecordingMib, 100)
  .option("--allow-remote", "explicitly allow a non-loopback listen address", false)
  .option("--advertise-host <host>", "hostname or IP shown to remote clients")
  .option("--username <username>", "username for remote mode (or MQTT_POCKETLAB_USERNAME)")
  .option("--password <password>", "password for remote mode (or MQTT_POCKETLAB_PASSWORD)")
  .action(async (options: StartOptions) => {
    const username = options.username ?? process.env.MQTT_POCKETLAB_USERNAME;
    const password = options.password ?? process.env.MQTT_POCKETLAB_PASSWORD;
    if (!isLoopback(options.host) && !options.allowRemote) {
      throw new Error("Non-loopback binding is disabled. Add --allow-remote plus --username and --password if intentional.");
    }
    if (!isLoopback(options.host) && (!username || !password)) {
      throw new Error("Remote mode requires --username and --password (environment variables are also supported).");
    }
    const lab = new PocketLab({
      host: options.host,
      mqttPort: options.mqttPort,
      webPort: options.webPort,
      maxRecordingBytes: Math.floor(options.maxRecordingMib * 1024 * 1024),
      ...(options.advertiseHost ? { advertiseHost: options.advertiseHost } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    });
    try {
      await lab.start();
      if (options.scenario) await lab.startScenario(options.scenario);
      if (options.record) await lab.startRecording(resolve(options.record));
      printBanner(lab, options.scenario, options.record);
      await waitForShutdown(async () => lab.stop());
    } finally {
      await lab.stop();
    }
  });

program
  .command("device")
  .description("Run one deterministic virtual device against any MQTT broker")
  .argument("<type>", "climate, co2, or meter")
  .option("--id <id>", "device id", `demo-${process.pid}`)
  .option("--seed <number>", "deterministic random seed", parseNumber, 42)
  .option("--interval <ms>", "publish interval in milliseconds", parseNumber, 2_000)
  .option("--broker <url>", "MQTT broker URL", "mqtt://127.0.0.1:1883")
  .option("--username <username>", "broker username")
  .option("--password <password>", "broker password")
  .action(async (type: string, options: DeviceCommandOptions) => {
    if (!isDeviceType(type)) throw new Error("Device type must be climate, co2, or meter.");
    const device = new VirtualDevice(
      options.broker,
      { type, id: options.id, seed: options.seed, intervalMs: options.interval },
      brokerCredentials(options),
    );
    device.on("telemetry", (message: unknown) => console.log(JSON.stringify(message)));
    device.on("warning", (error: unknown) => console.error(`[device warning] ${errorMessage(error)}`));
    device.start();
    console.log(`Virtual ${type} device '${options.id}' → ${redactUrlCredentials(options.broker)}`);
    console.log("Press Ctrl+C to stop.");
    await waitForShutdown(async () => device.stop());
  });

program
  .command("record")
  .description("Subscribe to a broker and record messages as portable NDJSON")
  .argument("<file>", "output .ndjson file")
  .option("--broker <url>", "MQTT broker URL", "mqtt://127.0.0.1:1883")
  .option("--topic <filter>", "MQTT subscription filter", "#")
  .option("--max-size-mib <mib>", "recording size limit in MiB", parseRecordingMib, 100)
  .option("--username <username>", "broker username")
  .option("--password <password>", "broker password")
  .action(async (file: string, options: BrokerCommandOptions & { topic: string; maxSizeMib: number }) => {
    const recorder = new NdjsonRecorder({
      maxBytes: Math.floor(options.maxSizeMib * 1024 * 1024),
      onWarning: (error) => console.error(`[recording warning] ${errorMessage(error)}`),
    });
    let client: MqttClient | null = null;
    try {
      const absolute = await recorder.start(file);
      client = await mqtt.connectAsync(options.broker, mqttOptions(options, `pocketlab-recorder-${process.pid}`));
      await client.subscribeAsync(options.topic, { qos: 0 });
      client.on("message", (topic, payload, packet) => {
        recorder.record({ topic, payload, qos: packet.qos, retain: packet.retain });
        if (recorder.state.records > 0 && recorder.state.records % 100 === 0) {
          process.stdout.write(`\rRecorded ${recorder.state.records} messages`);
        }
      });
      console.log(`Recording '${options.topic}' from ${redactUrlCredentials(options.broker)}`);
      console.log(`Output: ${absolute}`);
      console.log("Press Ctrl+C to stop.");
      await waitForShutdown(async () => undefined);
    } finally {
      if (client) await client.endAsync().catch(() => undefined);
      await recorder.stop();
      const state = recorder.state;
      console.log(`\nSaved ${state.records} messages (${state.bytes} bytes).`);
      if (state.dropped > 0) {
        console.error(`WARNING: ${state.dropped} message(s) were dropped because of recording limits or disk backpressure.`);
      }
    }
  });

program
  .command("replay")
  .description("Replay an NDJSON recording while preserving message timing")
  .argument("<file>", "input .ndjson file")
  .option("--broker <url>", "MQTT broker URL", "mqtt://127.0.0.1:1883")
  .option("--speed <multiplier>", "timing speed multiplier", parseNumber, 1)
  .option("--username <username>", "broker username")
  .option("--password <password>", "broker password")
  .action(async (file: string, options: BrokerCommandOptions & { speed: number }) => {
    const client = await mqtt.connectAsync(options.broker, mqttOptions(options, `pocketlab-replay-${process.pid}`));
    let lastReported = 0;
    try {
      const published = await replayNdjson(
        file,
        async (topic, payload, publishOptions) => {
          await client.publishAsync(topic, payload, publishOptions);
        },
        {
          speed: options.speed,
          onProgress: (count) => {
            if (count - lastReported >= 100) {
              lastReported = count;
              process.stdout.write(`\rReplayed ${count} messages`);
            }
          },
        },
      );
      console.log(`\nReplayed ${published} messages at ${options.speed}× speed.`);
    } finally {
      await client.endAsync();
    }
  });

program
  .command("scenarios")
  .description("List built-in device scenarios")
  .action(() => {
    for (const scenario of scenarios) {
      console.log(`${scenario.id.padEnd(16)} ${scenario.name} — ${scenario.description}`);
      console.log(`                 ${scenario.devices.map((device) => `${device.type}:${device.id}`).join(", ")}`);
    }
  });

interface StartOptions {
  host: string;
  mqttPort: number;
  webPort: number;
  scenario?: string;
  record?: string;
  maxRecordingMib: number;
  allowRemote: boolean;
  advertiseHost?: string;
  username?: string;
  password?: string;
}

interface BrokerCommandOptions {
  broker: string;
  username?: string;
  password?: string;
}

interface DeviceCommandOptions extends BrokerCommandOptions {
  id: string;
  seed: number;
  interval: number;
}

function mqttOptions(options: BrokerCommandOptions, clientId: string) {
  const credentials = brokerCredentials(options);
  return {
    clientId,
    protocolVersion: 4 as const,
    reconnectPeriod: 0,
    connectTimeout: 5_000,
    ...credentials,
  };
}

function brokerCredentials(options: BrokerCommandOptions): { username?: string; password?: string } {
  const username = options.username ?? process.env.MQTT_POCKETLAB_USERNAME;
  const password = options.password ?? process.env.MQTT_POCKETLAB_PASSWORD;
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function parseRecordingMib(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_240) {
    throw new Error(`Recording size must be greater than 0 and no more than 10240 MiB: ${value}`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`Invalid port: ${value}`);
  return parsed;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function isDeviceType(value: string): value is DeviceType {
  return value === "climate" || value === "co2" || value === "meter";
}

function printBanner(lab: PocketLab, scenario?: string, recording?: string): void {
  const line = "─".repeat(62);
  console.log(`\n┌${line}┐`);
  console.log("│  MQTT PocketLab — local IoT messages, visible and repeatable       │");
  console.log(`└${line}┘`);
  console.log(`  Console   ${lab.webUrl}`);
  console.log(`  MQTT      ${lab.mqttUrl}  (MQTT 3.1/3.1.1)`);
  console.log(`  Security  ${lab.localOnly ? "localhost only · anonymous" : "REMOTE · authentication required"}`);
  if (scenario) console.log(`  Scenario  ${scenario}`);
  if (recording) console.log(`  Record    ${resolve(recording)}`);
  console.log("\n  Press Ctrl+C for a clean shutdown.\n");
}

function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise((resolveWait, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void cleanup().then(resolveWait, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`mqtt-pocketlab: ${errorMessage(error)}`);
  process.exitCode = 1;
});
