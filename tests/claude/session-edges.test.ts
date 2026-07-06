/**
 * Conformance tests for Claude session terminal-state edge behavior.
 * Covers PRD §5.3, §8.4, and §9.4.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeSessionImpl } from "../../src/claude/session-instance.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession terminal-state edges", () => {
  test("C-PTY-05 ignores resize races against an already-closed PTY", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.resizeResult = "closed";
    await session.resize({ cols: 20, rows: 10 });
    expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
    expect(readRecord(cwd, session.elwoodSessionId).terminalSize).toEqual({ cols: 189, rows: 48 });
  });

  test("C-STATE-07 stop after process exit keeps the exited status", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.emitExit({ exitCode: 3 });
    await session.stop();
    expect(session.status).toBe("exited");
    expect(ptys[0]!.killSignals).toEqual([]);
  });

  test("C-LIFE-03 kill after process exit keeps the exited status", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.emitExit({ exitCode: 3 });
    await session.kill();
    expect(session.status).toBe("exited");
    expect(ptys[0]!.killSignals).toEqual([]);
  });

  test("C-STATE-08 teardown force-terminates a still-running session", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    await session.teardown();
    expect(session.status).toBe("torn_down");
    expect(ptys[0]!.killSignals).toEqual(["SIGKILL"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("C-PTY-06 ready and running markers are no-ops after exit", async () => {
    const cwd = tempDir();
    installFakes();
    const session = (await startClaude({ cwd })) as ClaudeSessionImpl;
    ptys[0]!.emitExit({ exitCode: 0 });
    session.markRunning();
    session.markReady();
    expect(session.status).toBe("exited");
  });

  test("C-STATE-02 keeps the first Claude session id for resume", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "claude-first"));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "claude-second"));
    expect(readRecord(cwd, session.elwoodSessionId).claude.resumeId).toBe("claude-first");
  });
});

function sessionStart(cwd: string, session_id: string): Record<string, unknown> {
  return { hook_event_name: "SessionStart", session_id, cwd, source: "startup" };
}

function readRecord(
  cwd: string,
  id: string,
): {
  readonly claude: { readonly resumeId?: string };
  readonly terminalSize?: { readonly cols: number; readonly rows: number };
} {
  return JSON.parse(readFileSync(join(cwd, ".elwood", "sessions", id, "session.json"), "utf8"));
}
