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

describe("ClaudeSessionApi terminal-state edges", () => {
  test("C-PTY-05 ignores resize races against an already-closed PTY", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    ptys[0]!.resizeResult = "closed";
    await session.resize({ cols: 20, rows: 10 });
    expect(session.terminal.size).toEqual({ cols: 189, rows: 48 });
    // Terminal size is never persisted (near-stateless): the record has no size field.
    expect(readRecord(cwd, session.elwoodSessionId)).not.toHaveProperty("terminalSize");
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

  test("C-API-33 statusDecisions logs applied transitions with reasons", async () => {
    const cwd = tempDir();
    installFakes();
    const decisions = (await startClaude({ cwd })).statusDecisions();
    const startup = decisions.find((d) => d.evidence === "startup_usable");
    expect(startup).toMatchObject({ from: "starting", to: "running" });
    expect(startup?.reason).toContain("applied");
    // The log carries no prompt/terminal content — only evidence + statuses.
    expect(Object.keys(decisions[0] ?? {}).sort()).toEqual(["evidence", "from", "reason", "to"]);
  });

  test("C-TURN-05 the OSC window title is exposed but never persisted", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // A spinner title arrives on the PTY stream and is tracked on the handle.
    ptys[0]!.emitData(`${String.fromCharCode(27)}]2;⠹ working${String.fromCharCode(7)}`);
    await expect.poll(() => session.terminal.title).toBe("⠹ working");
    const raw = readFileSync(
      join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
      "utf8",
    );
    expect(raw).not.toContain("⠹ working");
    expect(raw).not.toContain("title");
  });

  test("C-API-33 status decisions are live-only and never persisted", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // Drive a few transitions so the decision log is non-trivial.
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-persist",
      cwd,
    });
    expect(session.statusDecisions().length).toBeGreaterThan(0);
    const raw = readFileSync(
      join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
      "utf8",
    );
    // Status is live-only (never persisted), and neither are the decision-log internals.
    expect(raw).not.toContain("statusDecisions");
    expect(raw).not.toContain("decisions");
    expect(raw).not.toContain("startup_usable");
    expect(raw).not.toContain("initial_ready");
    expect(raw).not.toContain("applied:");
  });

  test("C-API-34 waitForStatus and waitForActivity resolve from session events", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // Resolves immediately from the current status.
    await expect(session.waitForStatus((s) => s === "running")).resolves.toBe("running");
    const activityWait = session.waitForActivity((e) => e.kind === "attention");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-wait",
      cwd,
    });
    ptys[0]!.emitData(
      "Do you want to create x.txt?\r\n ❯ 1. Yes\r\n   3. No\r\n Esc to cancel\r\n",
    );
    await expect(activityWait).resolves.toMatchObject({ kind: "attention" });
  });

  test("C-PTY-06 ready and running markers are no-ops after exit", async () => {
    const cwd = tempDir();
    installFakes();
    const session = (await startClaude({ cwd })) as ClaudeSessionImpl;
    ptys[0]!.emitExit({ exitCode: 0 });
    expect(session.submitEvidence("rendered_turn_started").to).toBeUndefined();
    expect(session.submitEvidence("rendered_turn_ended").to).toBeUndefined();
    expect(session.status).toBe("exited");
    expect(session.statusDecisions().at(-1)?.reason).toContain("ignored");
  });

  test("C-ATTN-01 a rendered permission dialog blocks and emits attention", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const attention: string[] = [];
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-attn",
      cwd,
    });
    ptys[0]!.emitData(
      "Do you want to create elwood.txt?\r\n ❯ 1. Yes\r\n   3. No\r\n Esc to cancel\r\n",
    );
    await expect.poll(() => session.status).toBe("blocked");
    expect(attention).toEqual(["claude-permission-dialog"]);
    ptys[0]!.emitData("[2J[H❯ \r\n  ready again\r\n");
    await expect.poll(() => session.status).toBe("ready");
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

function readRecord(cwd: string, id: string): { readonly claude: { readonly resumeId?: string } } {
  return JSON.parse(readFileSync(join(cwd, ".elwood", "sessions", id, "session.json"), "utf8"));
}
