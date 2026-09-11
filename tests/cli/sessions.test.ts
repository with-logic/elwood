/**
 * The sessions command's table, JSON, empty, skipped-record, and JSONL-rejection paths.
 * Covers PRD §12A.8 and C-CLI-22.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import type { ParsedListCommand } from "../../src/cli/command-types.ts";
import { runSessionsCommand } from "../../src/cli/sessions/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { ensureSocketHome, sessionSocketHome } from "../../src/state/socket-home.ts";
import { MemoryWriter } from "./run-fakes.ts";
import { cleanupSessionFixtures, plant, socketHomes, stateRoot } from "./sessions-fakes.ts";

afterEach(cleanupSessionFixtures);

function sessionsCommand(argv: readonly string[]): ParsedListCommand<"sessions"> {
  const parsed = parseCliArgs(["sessions", ...argv]);
  if (parsed.command !== "sessions") throw new Error("expected sessions");
  return parsed;
}

function harness(env: Readonly<Record<string, string>> = {}) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const context = {
    env,
    invocationCwd: tmpdir(),
    homeDir: join(tmpdir(), "no-such-home"),
    stdout: new AsyncOutputSink(stdout),
    stderr: new AsyncOutputSink(stderr),
  };
  return { stdout, stderr, context };
}

describe("runSessionsCommand", () => {
  test("C-CLI-22 renders an aligned table and warns about skipped records on stderr", async () => {
    const stateDir = stateRoot();
    plant(stateDir, "s-one", "claude", { resumeId: "c1", lastUsed: 1_800_000_000_000 });
    plant(stateDir, "s-two", "codex", { lastUsed: 1_700_000_000_000 });
    const home = sessionSocketHome({
      stateDir: resolve(stateDir),
      elwoodSessionId: "s-two",
      adapter: "codex",
    });
    socketHomes.push(home);
    ensureSocketHome(home);
    writeFileSync(join(home, "0badf00d.sock"), "");
    mkdirSync(join(stateDir, "sessions", "bad\u001b[31m"), { mode: 0o700 });
    const h = harness();
    expect(await runSessionsCommand(sessionsCommand(["--state-dir", stateDir]), h.context)).toBe(0);
    const lines = h.stdout.value.split("\n");
    expect(lines[0]).toMatch(/^ID {5}AGENT {3}LIVE {2}RESUMABLE {2}LAST USED {17}CREATED/);
    expect(lines[1]).toMatch(/^s-one {2}claude {2}no {4}yes {8}2027-01-15T08:00:00.000Z/);
    expect(lines[1]).toContain(resolve(tmpdir()));
    expect(lines[2]).toMatch(/^s-two {2}codex {3}yes {3}no {9}2023-11-14T22:13:20.000Z/);
    expect(h.stderr.value).toMatch(/^elwood: skipped session bad: Invalid Elwood session id/);
    expect(h.stderr.value).not.toContain("\u001b");
  });

  test("C-CLI-22 emits one JSON document and an empty array for an empty state directory", async () => {
    const stateDir = join(stateRoot(), "unused");
    const h = harness();
    expect(
      await runSessionsCommand(
        sessionsCommand(["--state-dir", stateDir, "--output", "json"]),
        h.context,
      ),
    ).toBe(0);
    expect(JSON.parse(h.stdout.value)).toEqual({
      schemaVersion: 1,
      type: "sessions",
      stateDir,
      sessions: [],
    });
    expect(h.stderr.value).toBe("");
  });

  test("C-CLI-22 empty text listing writes only a stderr notice", async () => {
    const stateDir = stateRoot();
    const h = harness();
    expect(await runSessionsCommand(sessionsCommand(["--state-dir", stateDir]), h.context)).toBe(0);
    expect(h.stdout.value).toBe("");
    expect(h.stderr.value).toBe(`No Elwood sessions in ${stateDir}.\n`);
  });

  test("C-CLI-22 rejects JSONL from a flag or an inherited source by name", async () => {
    const stateDir = stateRoot();
    await expect(
      runSessionsCommand(
        sessionsCommand(["--state-dir", stateDir, "--output", "jsonl"]),
        harness().context,
      ),
    ).rejects.toThrow(
      "JSONL output is selected by --output; sessions supports text or JSON output.",
    );
    await expect(
      runSessionsCommand(
        sessionsCommand(["--state-dir", stateDir]),
        harness({ ELWOOD_OUTPUT: "jsonl" }).context,
      ),
    ).rejects.toThrow("JSONL output is selected by ELWOOD_OUTPUT; sessions supports");
  });
});
