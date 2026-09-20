/** Reject special private files without blocking the host (PRD §8.2/§12A.5). */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

describe("private file FIFO rejection", () => {
  test.each(["state", "config"])("C-CLI-15 rejects a %s FIFO before reading", async (kind) => {
    const path = join(tempDir("elwood-fifo-"), "record");
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    chmodSync(path, 0o600);
    const module =
      kind === "state" ? "../../src/state/private-read.ts" : "../../src/cli/config/store.ts";
    const code = `
      import * as reader from ${JSON.stringify(new URL(module, import.meta.url).href)};
      process.send("ready");
      process.disconnect();
      try {
        ${kind === "state" ? "reader.readPrivateFile(process.argv[1], reader.currentFileOwner(), (message) => new Error(message))" : "reader.readConfig(process.argv[1])"};
        process.exitCode = 1;
      } catch (error) { console.log(error.message); }
    `;
    const result = await runReader(code, path);
    expect(result.timeoutPhase).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/regular file/);
  });
});

/** Start the FIFO deadline only after Node has loaded the reader's TypeScript imports. */
function runReader(code: string, path: string) {
  return new Promise<{
    readonly status: number | null;
    readonly stdout: string;
    readonly timeoutPhase: string | undefined;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", code, path],
      { stdio: ["ignore", "pipe", "inherit", "ipc"] },
    );
    let stdout = "";
    let timeoutPhase: string | undefined;
    const expire = (phase: string) => {
      timeoutPhase = phase;
      child.kill("SIGKILL");
    };
    // Under parallel load, launch/import alone exceeded 1s; the FIFO-rejection path took <5ms.
    let timer = setTimeout(() => expire("reader startup"), 5_000);
    child.once("message", () => {
      clearTimeout(timer);
      timer = setTimeout(() => expire("FIFO rejection"), 1_000);
    });
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, timeoutPhase });
    });
  });
}
