import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NdjsonRecorder, replayNdjson } from "../src/recording.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("NDJSON recording and replay", () => {
  it("preserves text, binary data, QoS, retain, and ordering", async () => {
    const directory = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    const file = join(directory, "roundtrip.ndjson");
    temporaryPaths.push(directory);
    const recorder = new NdjsonRecorder();
    await recorder.start(file);
    recorder.record({ topic: "lab/text", payload: Buffer.from("hello"), qos: 1, retain: true, ts: 1_000 });
    recorder.record({ topic: "lab/binary", payload: Buffer.from([0xff, 0x00, 0xfe]), qos: 0, ts: 1_010 });
    await recorder.stop();

    const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ topic: "lab/text", payload: "hello", encoding: "utf8", qos: 1, retain: true });
    expect(lines[1]).toMatchObject({ topic: "lab/binary", encoding: "base64" });

    const replayed: Array<{ topic: string; payload: Buffer; qos: number; retain: boolean }> = [];
    const count = await replayNdjson(
      file,
      async (topic, payload, options) => void replayed.push({ topic, payload, ...options }),
      { speed: 100 },
    );
    expect(count).toBe(2);
    expect(replayed[0]).toMatchObject({ topic: "lab/text", qos: 1, retain: true });
    expect(replayed[0]?.payload.toString()).toBe("hello");
    expect(replayed[1]?.payload).toEqual(Buffer.from([0xff, 0x00, 0xfe]));
  });

  it("rejects invalid replay speeds and unsafe topics", async () => {
    const directory = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    const file = join(directory, "invalid.ndjson");
    temporaryPaths.push(directory);
    const recorder = new NdjsonRecorder();
    await recorder.start(file);
    recorder.record({ topic: "valid/topic", payload: Buffer.from("ok"), ts: 1 });
    await recorder.stop();
    await expect(replayNdjson(file, async () => {}, { speed: 0 })).rejects.toThrow("Replay speed");
  });

  it("stops at its configured byte limit and reports backpressure without unbounded buffering", async () => {
    const directory = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    const file = join(directory, "bounded.ndjson");
    temporaryPaths.push(directory);
    const warnings: string[] = [];
    const recorder = new NdjsonRecorder({
      maxBytes: 600,
      onWarning: (error) => warnings.push(error.message),
    });
    await recorder.start(file);
    recorder.record({ topic: "bounded/one", payload: Buffer.from("x".repeat(300)), ts: 1 });
    recorder.record({ topic: "bounded/two", payload: Buffer.from("y".repeat(300)), ts: 2 });
    await recorder.stop();
    expect(recorder.state.active).toBe(false);
    expect(recorder.state.bytes).toBeLessThanOrEqual(600);
    expect(recorder.state.dropped).toBe(1);
    expect(warnings.join(" ")).toContain("limit");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);

    const pressureFile = join(directory, "pressure.ndjson");
    const pressureWarnings: string[] = [];
    const pressureRecorder = new NdjsonRecorder({
      maxBytes: 1024 * 1024,
      onWarning: (error) => pressureWarnings.push(error.message),
    });
    await pressureRecorder.start(pressureFile);
    expect(pressureRecorder.record({
      topic: "bounded/pressure",
      payload: Buffer.from("z".repeat(64 * 1024)),
      ts: 3,
    })).toBe(false);
    expect(pressureRecorder.state.backpressured).toBe(true);
    expect(pressureRecorder.record({ topic: "bounded/dropped", payload: Buffer.from("drop"), ts: 4 })).toBe(false);
    expect(pressureRecorder.state.dropped).toBe(1);
    expect(pressureWarnings.join(" ")).toContain("backpressured");
    await pressureRecorder.stop();
  });

  it("rejects reserved topics and decoded replay payloads over 1 MiB before publishing", async () => {
    const directory = join(tmpdir(), `mqtt-pocketlab-${randomUUID()}`);
    temporaryPaths.push(directory);
    await mkdir(directory, { recursive: true });
    const reserved = join(directory, "reserved.ndjson");
    const oversize = join(directory, "oversize.ndjson");
    await writeFile(
      reserved,
      `${JSON.stringify({ ts: 1, topic: "$SYS/unsafe", payload: "no", encoding: "utf8", qos: 0, retain: false })}\n`,
    );
    await writeFile(
      oversize,
      `${JSON.stringify({ ts: 1, topic: "unsafe/large", payload: "x".repeat(1_048_577), encoding: "utf8", qos: 0, retain: false })}\n`,
    );
    let publishes = 0;
    const publisher = async (): Promise<void> => { publishes += 1; };
    await expect(replayNdjson(reserved, publisher)).rejects.toThrow("reserved $SYS");
    await expect(replayNdjson(oversize, publisher)).rejects.toThrow("1 MiB replay limit");
    expect(publishes).toBe(0);
  });
});
