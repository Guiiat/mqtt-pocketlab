import { describe, expect, it, vi } from "vitest";
import {
  errorMessage,
  MAX_TIMER_DELAY_MS,
  redactUrlCredentials,
  sleep,
} from "../src/utils.js";

describe("abortable sleep", () => {
  it("removes its abort listener after a normal delay", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await sleep(1, controller.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("chunks delays beyond the Node timer limit and remains abortable", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const pending = sleep(MAX_TIMER_DELAY_MS + 1_000, controller.signal);
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS);
      controller.abort(new Error("test abort"));
      await expect(pending).rejects.toThrow("test abort");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes terminal controls and URL credentials from errors and display URLs", () => {
    const unsafe = "\u001B]8;;https://evil.example\u0007boom\u001B]8;;\u0007 mqtt://user:secret@broker.example\u0000";
    const safe = errorMessage(new Error(unsafe));
    expect(safe).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(safe).not.toContain("user");
    expect(safe).not.toContain("secret");
    expect(redactUrlCredentials("mqtt://alice:password@example.test:1883")).toContain("***:***@");
  });
});
