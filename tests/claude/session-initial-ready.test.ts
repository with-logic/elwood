/**
 * Conformance for Claude bounded initial-readiness (PRD §5.3, C-API-19, C-API-28):
 * initial readiness is hook-backed on `InstructionsLoaded`, but a missing or failed
 * hook bridge must NOT starve queued persona/messages forever — a bounded deadline
 * after the first rendered frame fires readiness exactly once as the only fallback.
 * All process signals go through injected fakes — no real signal is issued.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const PASTE = "[200~hello[201~";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

describe("ClaudeSession bounded initial readiness", () => {
  test("C-API-28 the deadline releases the queued message once when InstructionsLoaded never arrives", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    // A message queued before readiness stays unwritten while no readiness fires.
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);

    // Render a first frame — this arms the starvation deadline. WITHHOLD the
    // `InstructionsLoaded` hook entirely: the hook bridge is treated as never
    // firing, so only the deadline can release the queue.
    vi.useFakeTimers();
    ptys[0]!.emitData("claude rendered\r\n> ");
    expect(ptys[0]!.writes).toEqual([]); // nothing before the deadline elapses

    // Advance past the 10s bounded deadline (readiness fires) and flush the
    // paste's settle-delayed Enter, then let `queued` settle.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await queued;

    // The queued message released EXACTLY once: one bracketed paste + its Enter.
    expect(ptys[0]!.writes[0]).toBe(PASTE);
    expect(ptys[0]!.writes.filter((w) => w === PASTE)).toHaveLength(1);
    expect(ptys[0]!.writes).toContain("\r");
  });

  test("C-API-28 a later InstructionsLoaded after the deadline does not re-release the message", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");

    vi.useFakeTimers();
    ptys[0]!.emitData("claude rendered\r\n> ");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await queued;
    expect(ptys[0]!.writes.filter((w) => w === PASTE)).toHaveLength(1);

    // The InstructionsLoaded hook arriving late is idempotent: readiness already
    // latched via the deadline, so it must not release the message a second time.
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    expect(ptys[0]!.writes.filter((w) => w === PASTE)).toHaveLength(1);
  });
});
