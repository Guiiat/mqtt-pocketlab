import { describe, expect, it, vi } from "vitest";
import { VirtualDevice } from "../src/device.js";
import { PocketLab, simulatorHostForBinding, writeSseChunk } from "../src/lab.js";
import { mulberry32, normalizeDeviceId, validateTopic } from "../src/utils.js";

describe("deterministic device primitives", () => {
  it("produces the same pseudo-random sequence for a seed", () => {
    const first = mulberry32(2026);
    const second = mulberry32(2026);
    expect(Array.from({ length: 10 }, first)).toEqual(Array.from({ length: 10 }, second));
  });

  it("normalizes safe ids and rejects wildcard publish topics", () => {
    expect(normalizeDeviceId("greenhouse-01")).toBe("greenhouse-01");
    expect(() => normalizeDeviceId("../unsafe")).toThrow("Device id");
    expect(() => validateTopic("factory/+/temperature")).toThrow("cannot contain");
    expect(validateTopic("factory/line-a/temperature")).toBe("factory/line-a/temperature");
  });

  it("clamps unsafe device timing values", () => {
    const device = new VirtualDevice("mqtt://127.0.0.1:1", {
      type: "climate",
      id: "clamped",
      seed: 7,
      intervalMs: 1,
    });
    expect(device.snapshot()).toMatchObject({ id: "clamped", seed: 7, intervalMs: 100 });
  });

  it("uses the explicit bound host for simulators and loopback only for wildcard listeners", () => {
    expect(simulatorHostForBinding("192.0.2.10")).toBe("192.0.2.10");
    expect(simulatorHostForBinding("broker.example.test")).toBe("broker.example.test");
    expect(simulatorHostForBinding("0.0.0.0")).toBe("127.0.0.1");
    expect(simulatorHostForBinding("::")).toBe("::1");

    const advertised = new PocketLab({
      host: "192.0.2.10",
      advertiseHost: "lab.example.test",
      username: "user",
      password: "password",
    });
    expect(advertised.mqttUrl).toBe("mqtt://lab.example.test:1883");
    expect(() => new PocketLab({
      host: "192.0.2.10",
      advertiseHost: "http://unsafe.example",
      username: "user",
      password: "password",
    })).toThrow("Advertise host");
    expect(() => new PocketLab({
      host: "127.0.0.1",
      advertiseHost: "localhost",
    })).toThrow("only supported for non-loopback");
  });

  it("disconnects an SSE response that signals backpressure", () => {
    const response = { write: vi.fn(() => false), end: vi.fn() };
    expect(writeSseChunk(response, "data: test\n\n")).toBe(false);
    expect(response.end).toHaveBeenCalledOnce();
  });
});
