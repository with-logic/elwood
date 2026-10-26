/**
 * Codex config.toml reads never wait on, or read without bound from, a file the agent can
 * replace (PRD §5.3, C-CODEX-25).
 */

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { maxCodexConfigBytes, readCodexConfigFile } from "../../src/codex/config/read.ts";
import { fifoWithLateWriter, fifoWriterDelayMs } from "../helpers/fifo.ts";
import { tempDir } from "../helpers/tmp.ts";

function configPath(): string {
  return join(tempDir("elwood-config-read-"), "config.toml");
}

describe("readCodexConfigFile", () => {
  test("C-CODEX-25 the limit is 1 MiB", () => {
    expect(maxCodexConfigBytes).toBe(1_048_576);
  });

  test("C-CODEX-25 reads a regular file, through a symlink, up to the limit", () => {
    const path = configPath();
    const contents = `model = "gpt-5.4"\n${"#".repeat(maxCodexConfigBytes - 19)}\n`;
    expect(Buffer.byteLength(contents)).toBe(maxCodexConfigBytes);
    writeFileSync(path, contents);
    const link = join(tempDir("elwood-config-link-"), "config.toml");
    symlinkSync(path, link);
    expect(readCodexConfigFile(link)).toBe(contents);
  });

  test("C-CODEX-25 a missing config is no config", () => {
    expect(readCodexConfigFile(configPath())).toBeUndefined();
  });

  test("C-CODEX-25 a FIFO is rejected at once, without waiting for its writer", () => {
    const path = configPath();
    fifoWithLateWriter(path, 'model = "gpt-5.4"\n');
    const started = Date.now();
    expect(() => readCodexConfigFile(path)).toThrow(expect.objectContaining({ code: "EFTYPE" }));
    // Well inside the writer's delay: a read that waited for it could not finish this soon.
    expect(Date.now() - started).toBeLessThan(fifoWriterDelayMs / 2);
  });

  test("C-CODEX-25 a Unix socket, which macOS will not even open, is EFTYPE", async () => {
    const path = configPath();
    const server = createServer();
    await new Promise<void>((listening) => server.listen(path, listening));
    onTestFinished(() => new Promise<void>((closed) => server.close(() => closed())));
    expect(() => readCodexConfigFile(path)).toThrow(expect.objectContaining({ code: "EFTYPE" }));
  });

  test("C-CODEX-25 a regular file that cannot be opened keeps its own error", () => {
    const path = configPath();
    writeFileSync(path, 'model = "gpt-5.4"\n');
    chmodSync(path, 0o000);
    expect(() => readCodexConfigFile(path)).toThrow(expect.objectContaining({ code: "EACCES" }));
  });

  test.each([
    ["a directory", "EISDIR", (path: string) => mkdirSync(path)],
    [
      "one byte over the limit",
      "EFBIG",
      (path: string) => writeFileSync(path, "#".repeat(maxCodexConfigBytes + 1)),
    ],
    ["under a file instead of a directory", "ENOTDIR", (path: string) => writeFileSync(path, "")],
  ])("C-CODEX-25 a config that is %s throws %s", (name, code, make) => {
    const made = configPath();
    make(made);
    const path = name.startsWith("under") ? join(made, "config.toml") : made;
    expect(() => readCodexConfigFile(path)).toThrow(expect.objectContaining({ code }));
  });
});
