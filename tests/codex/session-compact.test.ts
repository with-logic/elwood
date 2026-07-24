/**
 * Conformance tests for Codex conversation compaction.
 * Covers PRD §5.7 and C-API-22.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi compact", () => {
  test("C-API-22 compact types /compact after readiness and resolves on PostCompact", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const compacted = session.compact();
    expect(ptys[0]!.writes).toEqual([]);
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => ptys[0]!.writes.length).toBe(2);
    expect(ptys[0]!.writes).toEqual(["/compact", "\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PostCompact",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      trigger: "manual",
    });
    await compacted;
    expect(session.status).toBe("ready");
  });

  test("C-API-22 compact rejects with compact_failed when no PostCompact arrives", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    const compacted = session.compact({ timeoutMs: 1_000 });
    // Command text, deferred command Enter, and the popup-recovery nudge Enter.
    await expect.poll(() => ptys[0]!.writes.length, { timeout: 2_000 }).toBe(3);
    expect(ptys[0]!.writes).toEqual(["/compact", "\r", "\r"]);
    await expect(compacted).rejects.toMatchObject({ code: "compact_failed" });
  });

  test("C-API-22 compact rejects with session_not_running when the session stops first", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const compacted = session.compact();
    await session.stop();
    await expect(compacted).rejects.toMatchObject({ code: "session_not_running" });
  });
});
