/**
 * Conformance tests for Claude narrow-bootstrap resize semantics.
 * Covers PRD §5.3, C-API-36 (bootstrap + deferred restore of the latest held size),
 * and C-API-39 (restore-failure warning vs benign closed-fd no-op). Terminal size is
 * NOT persisted (near-stateless): the held size lives in memory and is applied
 * physically at readiness; nothing is written to disk.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeSessionImpl } from "../../src/claude/session-instance.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const ESC = String.fromCharCode(27);
const PASTE = `${ESC}[200~hello${ESC}[201~`;

/** The on-disk record never carries a terminalSize (near-stateless). */
function recordHasNoSize(cwd: string, id: string): boolean {
  const record = readFileSync(join(cwd, ".elwood", "sessions", id, "session.json"), "utf8");
  return !("terminalSize" in JSON.parse(record));
}

async function reachReady(cwd: string, id: string): Promise<void> {
  await ptys[0]!.dispatchHook(id, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
}

describe("ClaudeSession narrow-bootstrap resize", () => {
  test("C-API-19 C-API-36 bootstraps wide, holds resizes in memory, then restores the latest", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const queued = session.sendMessage("hello");
    // A pre-ready resize holds the PHYSICAL resize (pty stays at bootstrap width); the
    // requested size lives in memory only — nothing is persisted (near-stateless).
    await session.resize({ cols: 72, rows: 9 });
    expect(ptys[0]!.size).toEqual({ cols: 100, rows: 10 });
    expect(recordHasNoSize(cwd, session.elwoodSessionId)).toBe(true);
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.options.size).toEqual({ cols: 100, rows: 10 });
    // The latest requested size is applied physically at readiness.
    expect(ptys[0]!.size).toEqual({ cols: 72, rows: 9 });
    await session.resize({ cols: 60, rows: 8 });
    expect(ptys[0]!.size).toEqual({ cols: 60, rows: 8 });
    await (session as ClaudeSessionImpl).completeInitialReady(); // one-shot replay is idempotent
  });

  test("C-API-36 the LAST pre-ready resize wins and is the one restored at readiness", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const queued = session.sendMessage("hello");
    await session.resize({ cols: 70, rows: 11 });
    await session.resize({ cols: 74, rows: 12 });
    await session.resize({ cols: 80, rows: 20 });
    // Physical resize held at bootstrap; only the LAST requested size is remembered.
    expect(ptys[0]!.size).toEqual({ cols: 100, rows: 10 });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.size).toEqual({ cols: 80, rows: 20 });
  });

  test("C-API-39 a real restore failure warns, stays at bootstrap width, still releases input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const warnings: { code: string }[] = [];
    session.on("warning", (event) => warnings.push(event));
    const queued = session.sendMessage("hello");
    ptys[0]!.resizeError = Object.assign(new Error("resize failed"), { code: "EIO" });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    // The restore did NOT apply: Claude stays at the safe bootstrap width, but
    // input is still released and the failure is surfaced live (not swallowed).
    expect(ptys[0]!.size).toEqual({ cols: 100, rows: 10 });
    expect(warnings.find((w) => w.code === "resize_restore_failed")).toMatchObject({
      code: "resize_restore_failed",
      requestedCols: 68,
      requestedRows: 10,
      errorCode: "EIO",
    });
    expect(ptys[0]!.writes[0]).toBe(PASTE);
  });

  test("C-API-39 a closed PTY at restore stays a silent no-op (no warning)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    const queued = session.sendMessage("hello");
    ptys[0]!.resizeResult = "closed"; // benign process-exit race, not a real error
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(warnings).not.toContain("resize_restore_failed");
    expect(session.status).toBe("running");
  });

  test("C-API-36 a session requested at 100+ columns resizes immediately, not held", async () => {
    const cwd = tempDir();
    installFakes();
    // Wide session: no bootstrap deferral, so a pre-ready resize applies at once.
    const session = await startClaude({ cwd, initialSize: { cols: 120, rows: 30 } });
    await session.resize({ cols: 130, rows: 32 });
    expect(ptys[0]!.size).toEqual({ cols: 130, rows: 32 });
  });

  test("C-API-25 a wide-session resize throwing a non-Error rejects with a normalized Error", async () => {
    const cwd = tempDir();
    installFakes();
    // Wide session goes through the base resize path; a non-Error synchronous
    // throw is normalized into an Error rejection rather than escaping raw.
    const session = await startClaude({ cwd, initialSize: { cols: 120, rows: 30 } });
    ptys[0]!.resizeError = "raw pty failure" as unknown as Error;
    await expect(session.resize({ cols: 130, rows: 32 })).rejects.toThrow("raw pty failure");
  });

  test("C-API-39 a throwing warning listener at restore still advances to ready and releases input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    // A rogue warning listener throws during restore-failure delivery; readiness
    // must still advance so the queued message is never permanently starved.
    const statuses: string[] = [];
    session.on("status", (event) => statuses.push(event.status));
    session.on("warning", () => {
      throw new Error("rogue warning listener");
    });
    const queued = session.sendMessage("hello");
    ptys[0]!.resizeError = Object.assign(new Error("resize failed"), { code: "EIO" });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    // The `ready` status evidence is NOT lost — it advanced before the queued
    // message drained; only the downstream listener throw was contained.
    expect(statuses).toContain("ready");
    expect(ptys[0]!.writes[0]).toBe(PASTE);
  });
});
