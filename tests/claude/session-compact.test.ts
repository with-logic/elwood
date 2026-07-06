/**
 * Conformance tests for Claude conversation compaction.
 * Covers PRD §5.3 and C-API-22.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const instructionsLoaded = (cwd: string) => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: "/tmp/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
});

describe("ClaudeSession compact", () => {
  test("C-API-22 compact types /compact after readiness and resolves on PostCompact", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const compacted = session.compact();
    expect(ptys[0]!.writes).toEqual([]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await expect.poll(() => ptys[0]!.writes.length).toBe(2);
    expect(ptys[0]!.writes).toEqual(["/compact", "\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PostCompact",
      session_id: "claude-1",
      cwd,
      trigger: "manual",
      compact_summary: "summary",
    });
    await compacted;
    expect(session.status).toBe("running");
  });

  test("C-API-22 compact rejects with compact_failed when no PostCompact arrives", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    const compacted = session.compact({ timeoutMs: 1_000 });
    // Command text, deferred command Enter, and the popup-recovery nudge Enter.
    await expect.poll(() => ptys[0]!.writes.length, { timeout: 2_000 }).toBe(3);
    expect(ptys[0]!.writes).toEqual(["/compact", "\r", "\r"]);
    await expect(compacted).rejects.toMatchObject({ code: "compact_failed" });
  });

  test("C-API-22 compact rejects with session_not_running when the session stops first", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const compacted = session.compact();
    await session.stop();
    await expect(compacted).rejects.toMatchObject({ code: "session_not_running" });
  });
});
