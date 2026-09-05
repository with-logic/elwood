/**
 * Installed-artifact conformance coverage for the Elwood CLI package boundary.
 * Covers PRD §12A, C-CLI-01, and C-CLI-02.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { bootstrapCliIfMain, type CliProcess, runCli } from "../../src/cli/entry.ts";
import { main } from "../../src/cli/main.ts";

function captureIo(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: Parameters<typeof main>[1];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
    },
  };
}

describe("installed CLI package", () => {
  test.each([
    { args: [] },
    { args: ["help"] },
    { args: ["--help"] },
    { args: ["-h"] },
  ])("C-CLI-02 renders help without an agent for $args", ({ args }) => {
    const captured = captureIo();
    expect(main(args, captured.io)).toBe(0);
    expect(captured.stdout.join("")).toContain("Usage: elwood");
    expect(captured.stderr).toEqual([]);
  });

  test.each([{ args: ["--version"] }, { args: ["-V"] }])("C-CLI-02 renders version for $args", ({
    args,
  }) => {
    const captured = captureIo();
    expect(main(args, captured.io)).toBe(0);
    expect(captured.stdout).toEqual(["0.0.0\n"]);
    expect(captured.stderr).toEqual([]);
  });

  test("C-CLI-02 rejects execution paths outside the metadata scaffold", () => {
    const captured = captureIo();
    expect(main(["hello"], captured.io)).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("")).toContain("not available");
  });

  test("C-CLI-01 entry binds arguments, streams, and status only when it is main", () => {
    const captured = captureIo();
    const proc: CliProcess = {
      argv: ["node", "/tmp/elwood-entry.js", "--help"],
      exitCode: undefined,
      ...captured.io,
    };
    expect(bootstrapCliIfMain({ url: "file:///tmp/not-entry.js" }, proc)).toBeNull();
    expect(bootstrapCliIfMain({ url: "file:///tmp/elwood-entry.js" }, proc)).toBe(0);
    expect(proc.exitCode).toBe(0);
    expect(captured.stdout.join("")).toContain("Usage: elwood");

    const noEntry: CliProcess = { argv: ["node"], exitCode: undefined, ...captureIo().io };
    expect(bootstrapCliIfMain({ url: "file:///tmp/elwood-entry.js" }, noEntry)).toBeNull();
    expect(
      runCli({ argv: ["node", "entry", "not-ready"], exitCode: undefined, ...captureIo().io }),
    ).toBe(2);
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
