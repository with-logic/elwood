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
  const escapes = (writes: readonly string[]) => writes.filter((w) => w === "\u001b").length;

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

  test("C-API-38 concurrent interrupts coalesce into a single Escape", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await session.sendMessage("write a long essay");
    // Two callers race an interrupt: only one Escape may reach the terminal, or
    // the second would land on the composer the first just made idle.
    const first = session.interrupt();
    const second = session.interrupt();
    await expect.poll(() => escapes(ptys[0]!.writes)).toBe(1);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopHook(cwd));
    await Promise.all([first, second]);
    expect(escapes(ptys[0]!.writes)).toBe(1);
  });

  test("C-API-38 Escape interleaves with an in-flight prompt's paste and delayed Enter", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    // sendPrompt writes the bracketed paste, then its submitting Enter after a
    // settle delay. Do NOT await it: interrupt during that window proves raw
    // Escape bypasses the queue and lands between the paste and the Enter.
    const prompted = session.sendPrompt("essay");
    await expect.poll(() => ptys[0]!.writes.length).toBe(1);
    expect(ptys[0]!.writes[0]).toBe("\u001b[200~essay\u001b[201~");
    // The interrupt's Escape write is immediate; its promise only settles once
    // the turn ends, which the Stop hook below drives. Observe writes, don't await.
    const interrupted = session.interrupt();
    await expect.poll(() => ptys[0]!.writes.length).toBe(3);
    await prompted;
    // paste, then Escape, then the prompt's delayed submitting Enter.
    expect(ptys[0]!.writes).toEqual(["\u001b[200~essay\u001b[201~", "\u001b", "\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopHook(cwd));
    await interrupted;
  });

  test("C-API-38 interrupt with no turn in flight resolves without writing", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await session.interrupt();
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("C-API-38 interrupt before initial readiness is a no-op on the booting TUI", async () => {
    const cwd = tempDir();
    installFakes();
    // No InstructionsLoaded yet: status is the startup `running` bootstrap, not
    // a turn. Escape here would perturb the booting TUI, so interrupt no-ops.
    const session = await startClaude({ cwd });
    expect(session.status).toBe("running");
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
