/**
 * Conformance tests for Claude turn interrupts.
 * Covers PRD §5.3 and C-API-38.
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

const stopHook = (cwd: string) => ({
  hook_event_name: "Stop",
  session_id: "claude-1",
  cwd,
  stop_hook_active: false,
});

describe("ClaudeSession interrupt", () => {
  test("C-API-38 interrupt writes Escape immediately mid-turn and resolves on ready", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await session.sendMessage("write a long essay");
    expect(session.status).toBe("running");
    const interrupted = session.interrupt();
    // Escape bypasses the readiness queue: it lands while the turn still runs.
    await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopHook(cwd));
    await interrupted;
    expect(session.status).toBe("ready");
  });

  test("C-API-38 interrupt with no turn in flight resolves without writing", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await session.interrupt();
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("C-API-38 interrupt rejects with interrupt_failed when the turn never ends", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await session.sendMessage("write a long essay");
    const interrupted = session.interrupt({ timeoutMs: 100 });
    await expect(interrupted).rejects.toMatchObject({ code: "interrupt_failed" });
  });

  test("C-API-38 interrupt rejects with session_not_running when the session stops first", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await session.sendMessage("write a long essay");
    const interrupted = session.interrupt();
    await session.stop();
    await expect(interrupted).rejects.toMatchObject({ code: "session_not_running" });
  });

  test("C-API-25 interrupt after a terminal status rejects with session_not_running", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.stop();
    await expect(session.interrupt()).rejects.toMatchObject({ code: "session_not_running" });
  });
});
