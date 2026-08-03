import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI lifecycle", () => {
  it("closes both listeners when startup fails after the lab has started", async () => {
    const result = await runCli([
      "start",
      "--mqtt-port", "0",
      "--web-port", "0",
      "--scenario", "does-not-exist",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown scenario");
  });

  it("closes the recorder when the initial broker connection fails", async () => {
    const directory = join(tmpdir(), `mqtt-pocketlab-cli-${randomUUID()}`);
    const file = join(directory, "unreachable.ndjson");
    temporaryPaths.push(directory);
    await mkdir(directory, { recursive: true });
    const result = await runCli([
      "record",
      file,
      "--broker", "mqtt://user:secret@127.0.0.1:1",
    ], 10_000);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("user:secret");
    expect(result.stdout).toContain("Saved 0 messages");
    await rm(file);
  });
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: readonly string[], timeoutMs = 8_000): Promise<CliResult> {
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return await new Promise<CliResult>((resolveRun, reject) => {
    const child = spawn(process.execPath, [tsx, "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, stdout, stderr });
    });
  });
}
