/**
 * Conformance tests for Claude narrow-bootstrap resize semantics.
 * Covers PRD §5.3, C-API-36 (bootstrap + held-size persistence), and C-API-39
 * (restore-failure warning vs benign closed-fd no-op).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ClaudeSessionImpl } from "../../src/claude/session-instance.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** Read the durably-persisted `terminalSize` from a session's on-disk record. */
function persistedSize(cwd: string, id: string): unknown {
  const record = readFileSync(join(cwd, ".elwood", "sessions", id, "session.json"), "utf8");
  return JSON.parse(record).terminalSize;
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
  test("C-API-19 C-API-36 bootstraps wide, persists held sizes, then restores the latest", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const queued = session.sendMessage("hello");
    // A pre-ready resize holds the PHYSICAL resize (pty stays at bootstrap width)
    // but still durably persists the requested size right away.
    await session.resize({ cols: 72, rows: 9 });
    expect(ptys[0]!.size).toEqual({ cols: 100, rows: 10 });
    expect(persistedSize(cwd, session.elwoodSessionId)).toEqual({ cols: 72, rows: 9 });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.options.size).toEqual({ cols: 100, rows: 10 });
    // The latest requested size is applied physically at readiness.
    expect(ptys[0]!.size).toEqual({ cols: 72, rows: 9 });
    await session.resize({ cols: 60, rows: 8 });
    expect(ptys[0]!.size).toEqual({ cols: 60, rows: 8 });
    await (session as ClaudeSessionImpl).completeInitialReady(); // one-shot replay is idempotent
  });

  test("C-API-36 the LAST pre-ready resize wins and is the one persisted and restored", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const queued = session.sendMessage("hello");
    await session.resize({ cols: 70, rows: 11 });
    await session.resize({ cols: 74, rows: 12 });
    await session.resize({ cols: 80, rows: 20 });
    // Physical resize held at bootstrap; only the LAST requested size is persisted.
    expect(ptys[0]!.size).toEqual({ cols: 100, rows: 10 });
    expect(persistedSize(cwd, session.elwoodSessionId)).toEqual({ cols: 80, rows: 20 });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.size).toEqual({ cols: 80, rows: 20 });
  });

  test("C-API-39 a real restore failure warns, stays at bootstrap width, still releases input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    const queued = session.sendMessage("hello");
    ptys[0]!.resizeError = Object.assign(new Error("resize failed"), { code: "EIO" });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    // The restore did NOT apply: Claude stays at the safe bootstrap width, but
    // input is still released and the failure is surfaced (not swallowed).
    expect(ptys[0]!.size).toEqual({ cols: 100, rows: 10 });
    expect(warnings).toContain("resize_restore_failed");
    expect(session.warnings.find((w) => w.code === "resize_restore_failed")).toMatchObject({
      code: "resize_restore_failed",
      requestedCols: 68,
      requestedRows: 10,
      errorCode: "EIO",
    });
    expect(ptys[0]!.writes[0]).toBe("[200~hello[201~");
  });

  test("C-API-39 a closed PTY at restore stays a silent no-op (no warning)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 68, rows: 10 } });
    const queued = session.sendMessage("hello");
    ptys[0]!.resizeResult = "closed"; // benign process-exit race, not a real error
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(session.warnings.find((w) => w.code === "resize_restore_failed")).toBeUndefined();
    expect(session.status).toBe("running");
  });
});
