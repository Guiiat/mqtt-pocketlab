import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import mqtt, { type MqttClient } from "mqtt";
import { afterEach, describe, expect, it } from "vitest";
import { limits, PocketLab } from "../src/lab.js";

const labs: PocketLab[] = [];
const clients: MqttClient[] = [];
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.endAsync().catch(() => undefined)));
  await Promise.all(labs.splice(0).map((lab) => lab.stop()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PocketLab integration", () => {
  it("starts on ephemeral ports, serves the console, observes MQTT, and controls devices", async () => {
    const recordings = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    temporaryPaths.push(recordings);
    const lab = new PocketLab({ mqttPort: 0, webPort: 0, recordingDirectory: recordings });
    labs.push(lab);
    await lab.start();
    expect(lab.localOnly).toBe(true);
    expect(lab.mqttPort).toBeGreaterThan(0);
    expect(lab.webPort).toBeGreaterThan(0);

    const page = await fetch(lab.webUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Your MQTT system");

    const client = await mqtt.connectAsync(lab.mqttUrl, {
      clientId: "integration-client",
      protocolVersion: 4,
      reconnectPeriod: 0,
    });
    clients.push(client);
    await client.publishAsync("tests/temperature", Buffer.from("21.5"), { qos: 1, retain: true });
    await until(() => lab.state().topics.some((topic) => topic.topic === "tests/temperature"));
    expect(lab.state().clients.map((item) => item.id)).toContain("integration-client");
    expect(lab.state().topics.find((topic) => topic.topic === "tests/temperature")).toMatchObject({
      payload: "21.5",
      qos: 1,
    });

    const createDevice = await fetch(`${lab.webUrl}/api/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "co2", id: "test-air", seed: 17, intervalMs: 100 }),
    });
    expect(createDevice.status).toBe(201);
    await until(() => lab.state().devices[0]?.sequence > 0);
    expect(lab.state().devices[0]).toMatchObject({ id: "test-air", type: "co2", seed: 17 });

    const fault = await fetch(`${lab.webUrl}/api/devices/test-air/fault`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "spike", factor: 5, readings: 2 }),
    });
    expect(fault.status).toBe(202);
  });

  it("records traffic through the REST API and protects remote binding", async () => {
    expect(() => new PocketLab({ host: "0.0.0.0" })).toThrow("requires both a username and password");
    const recordings = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    temporaryPaths.push(recordings);
    const lab = new PocketLab({ mqttPort: 0, webPort: 0, recordingDirectory: recordings });
    labs.push(lab);
    await lab.start();
    const start = await fetch(`${lab.webUrl}/api/recording/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "integration.ndjson" }),
    });
    expect(start.status).toBe(201);
    expect(await start.json()).toMatchObject({ file: "integration.ndjson", maxBytes: 104_857_600 });
    expect(lab.state().recording.file).toBe("integration.ndjson");
    const publish = await fetch(`${lab.webUrl}/api/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "tests/rest", payload: "captured", qos: 0 }),
    });
    expect(publish.status).toBe(202);
    await until(() => lab.state().recording.records >= 1);
    const stop = await fetch(`${lab.webUrl}/api/recording/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(stop.status).toBe(200);
  });

  it("requires JSON and same-origin mutation requests and rejects unsafe Host and file paths", async () => {
    const recordings = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    temporaryPaths.push(recordings);
    const lab = new PocketLab({ mqttPort: 0, webPort: 0, recordingDirectory: recordings });
    labs.push(lab);
    await lab.start();

    const wrongType = await fetch(`${lab.webUrl}/api/scenarios/smart-home/start`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const crossOrigin = await fetch(`${lab.webUrl}/api/scenarios/smart-home/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);

    const crossSiteWithoutOrigin = await fetch(`${lab.webUrl}/api/replay/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      body: "{}",
    });
    expect(crossSiteWithoutOrigin.status).toBe(403);

    expect(await rawRequestStatus(`${lab.webUrl}/api/state`, {
      Host: `localhost:${lab.webPort}`,
    })).toBe(403);

    const missingFile = await fetch(`${lab.webUrl}/api/recording/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: lab.webUrl },
      body: "{}",
    });
    expect(missingFile.status).toBe(400);

    const traversal = await fetch(`${lab.webUrl}/api/recording/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: lab.webUrl },
      body: JSON.stringify({ file: "../escape.ndjson" }),
    });
    expect(traversal.status).toBe(400);

    const sameOrigin = await fetch(`${lab.webUrl}/api/scenarios/smart-home/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: lab.webUrl },
      body: "{}",
    });
    expect(sameOrigin.status).toBe(202);
    expect(lab.state().devices.length).toBeGreaterThan(0);
  });

  it("enforces authentication when remotely bound and advertises an explicit client host", async () => {
    const lab = new PocketLab({
      host: "0.0.0.0",
      advertiseHost: "127.0.0.1",
      mqttPort: 0,
      webPort: 0,
      username: "remote-user",
      password: "remote-password",
    });
    labs.push(lab);
    await lab.start();
    expect(lab.localOnly).toBe(false);
    expect(lab.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);

    expect((await fetch(`${lab.webUrl}/api/state`)).status).toBe(401);
    const authorization = `Basic ${Buffer.from("remote-user:remote-password").toString("base64")}`;
    expect((await fetch(`${lab.webUrl}/api/state`, { headers: { Authorization: authorization } })).status).toBe(200);

    await expect(mqtt.connectAsync(lab.mqttUrl, {
      clientId: "unauthorized-remote",
      protocolVersion: 4,
      reconnectPeriod: 0,
      connectTimeout: 1_000,
    })).rejects.toThrow();
    const client = await mqtt.connectAsync(lab.mqttUrl, {
      clientId: "authorized-remote",
      protocolVersion: 4,
      reconnectPeriod: 0,
      username: "remote-user",
      password: "remote-password",
    });
    clients.push(client);
    expect(client.connected).toBe(true);
  });

  it("bounds concurrent SSE clients", async () => {
    const lab = new PocketLab({ mqttPort: 0, webPort: 0 });
    labs.push(lab);
    await lab.start();
    const streams: Response[] = [];
    try {
      for (let index = 0; index < limits.maxSseClients; index += 1) {
        const response = await fetch(`${lab.webUrl}/api/events`);
        expect(response.status).toBe(200);
        streams.push(response);
      }
      const overflow = await fetch(`${lab.webUrl}/api/events`);
      expect(overflow.status).toBe(503);
    } finally {
      await Promise.all(streams.map(async (response) => response.body?.cancel()));
    }
  });

  it("stops in bounded time while MQTT clients are still connected", async () => {
    const lab = new PocketLab({ mqttPort: 0, webPort: 0 });
    labs.push(lab);
    await lab.start();
    const client = await mqtt.connectAsync(lab.mqttUrl, {
      clientId: "still-connected",
      protocolVersion: 4,
      reconnectPeriod: 0,
    });
    clients.push(client);
    await Promise.race([
      lab.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Shutdown was not bounded.")), 2_000)),
    ]);
    expect(lab.state().clients).toHaveLength(0);
  });

  it("prevents record/replay feedback and validates messages replayed through the broker", async () => {
    const recordings = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    temporaryPaths.push(recordings);
    await mkdir(recordings, { recursive: true });
    await writeFile(
      join(recordings, "slow.ndjson"),
      [
        JSON.stringify({ ts: 1, topic: "safe/one", payload: "one", encoding: "utf8", qos: 0, retain: false }),
        JSON.stringify({ ts: 10_001, topic: "safe/two", payload: "two", encoding: "utf8", qos: 0, retain: false }),
      ].join("\n"),
    );
    await writeFile(
      join(recordings, "reserved.ndjson"),
      `${JSON.stringify({ ts: 1, topic: "$SYS/forbidden", payload: "no", encoding: "utf8", qos: 0, retain: false })}\n`,
    );
    await writeFile(
      join(recordings, "oversize.ndjson"),
      `${JSON.stringify({ ts: 1, topic: "unsafe/oversize", payload: "x".repeat(1_048_577), encoding: "utf8", qos: 0, retain: false })}\n`,
    );
    const lab = new PocketLab({ mqttPort: 0, webPort: 0, recordingDirectory: recordings });
    labs.push(lab);
    await lab.start();

    await fetch(`${lab.webUrl}/api/recording/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "capture.ndjson" }),
    });
    const replayDuringRecord = await fetch(`${lab.webUrl}/api/replay/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "slow.ndjson", speed: 1 }),
    });
    expect(replayDuringRecord.status).toBe(409);
    await fetch(`${lab.webUrl}/api/recording/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    await fetch(`${lab.webUrl}/api/replay/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "slow.ndjson", speed: 0.05 }),
    });
    expect(lab.state().replay.active).toBe(true);
    const recordDuringReplay = await fetch(`${lab.webUrl}/api/recording/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "capture.ndjson" }),
    });
    expect(recordDuringReplay.status).toBe(409);
    await fetch(`${lab.webUrl}/api/replay/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await until(() => !lab.state().replay.active);

    const messagesBefore = lab.state().throughput.totalMessages;
    await fetch(`${lab.webUrl}/api/replay/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "reserved.ndjson", speed: 1 }),
    });
    await until(() => !lab.state().replay.active);
    expect(lab.state().throughput.totalMessages).toBe(messagesBefore);
    expect(lab.state().topics.some((topic) => topic.topic.startsWith("$SYS/"))).toBe(false);

    await fetch(`${lab.webUrl}/api/replay/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "oversize.ndjson", speed: 1 }),
    });
    await until(() => !lab.state().replay.active);
    expect(lab.state().throughput.totalMessages).toBe(messagesBefore);
    expect(lab.state().topics.some((topic) => topic.topic === "unsafe/oversize")).toBe(false);
  });
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function rawRequestStatus(url: string, headers: Record<string, string>): Promise<number> {
  const parsed = new URL(url);
  return await new Promise<number>((resolveRequest, reject) => {
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
        headers,
      },
      (response) => {
        response.resume();
        resolveRequest(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}
