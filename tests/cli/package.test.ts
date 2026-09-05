/**
 * Installed-artifact and Node process-boundary conformance coverage (PRD §12A, C-CLI-01/02).
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { bootstrapCliIfMain, type CliProcess, runCli } from "../../src/cli/entry.ts";
import { main } from "../../src/cli/main.ts";
import { mainHarness } from "./main-fakes.ts";
import { MemoryWriter } from "./run-fakes.ts";

function fakeProcess(argv: readonly string[]): {
  readonly proc: CliProcess;
  readonly stdout: MemoryWriter;
  readonly stderr: MemoryWriter;
  readonly listeners: Set<() => void>;
} {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const listeners = new Set<() => void>();
  const stdin = {
    isTTY: true,
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {},
  };
  return {
    stdout,
    stderr,
    listeners,
    proc: {
      argv,
      stdout,
      stderr,
      stdin,
      env: {},
      cwd: () => "/tmp",
      on: (_event, handler) => listeners.add(handler),
      off: (_event, handler) => listeners.delete(handler),
      exitCode: undefined,
    },
  };
}

describe("installed CLI package", () => {
  test.each(
    ["help", "--help", "-h"].map((arg) => ({ args: [arg] })),
  )("C-CLI-02 renders help without an agent for $args", async ({ args }) => {
    const captured = mainHarness();
    expect(await main(args, captured.context)).toBe(0);
    expect(captured.stdout.value).toContain("Usage: elwood");
    expect(captured.stderr.value).toBe("");
  });

  test.each(
    ["--version", "-V"].map((arg) => ({ args: [arg] })),
  )("C-CLI-02 renders version for $args", async ({ args }) => {
    const captured = mainHarness();
    expect(await main(args, captured.context)).toBe(0);
    expect(captured.stdout.value).toBe("0.0.0\n");
    expect(captured.stderr.value).toBe("");
  });

  test("C-CLI-01 entry binds arguments, streams, and status only when main", async () => {
    const h = fakeProcess(["node", "/tmp/elwood-entry.js", "--help"]);
    expect(bootstrapCliIfMain({ url: "file:///tmp/not-entry.js" }, h.proc)).toBeNull();
    const pending = bootstrapCliIfMain(
      { url: "file:///tmp/elwood-entry.js" },
      h.proc,
      undefined,
      "/tmp",
    );
    await expect(pending).resolves.toBe(0);
    expect(h.proc.exitCode).toBe(0);
    expect(h.stdout.value).toContain("Usage: elwood");

    const noEntry = fakeProcess(["node"]);
    expect(bootstrapCliIfMain({ url: "file:///tmp/elwood-entry.js" }, noEntry.proc)).toBeNull();
    const direct = fakeProcess(["node", "entry", "--help"]);
    await expect(runCli(direct.proc)).resolves.toBe(0);
  });

  test("C-CLI-01 emitted entry is executable JavaScript with declarations", () => {
    accessSync("dist/cli/entry.js", constants.X_OK);
    expect(readFileSync("dist/cli/entry.js", "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/u);
    expect(readFileSync("dist/index.d.ts", "utf8")).toContain("export");
    const help = execFileSync(process.execPath, ["dist/cli/entry.js", "--help"], {
      encoding: "utf8",
    });
    expect(help).toContain("Usage: elwood");
  });
});
