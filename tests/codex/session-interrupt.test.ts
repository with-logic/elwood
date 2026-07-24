/**
 * Conformance tests for Codex turn interrupts.
 * Covers PRD §5.7 and C-API-38.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { CodexHookEventFor } from "../../src/index.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const stopHook = (cwd: string) =>
  ({
    hook_event_name: "Stop",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    turn_id: "turn-1",
    stop_hook_active: false,
  }) satisfies CodexHookEventFor<"Stop">;

describe("CodexSessionApi interrupt", () => {
  test("C-API-38 interrupt writes Escape immediately mid-turn and resolves on ready", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
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
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    await session.interrupt();
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("C-API-38 interrupt before initial readiness is a no-op on the booting TUI", async () => {
    const cwd = tempDir();
    installFakes();
    // No SessionStart yet: status is the startup `running` bootstrap, not a turn.
    // Escape here would perturb the booting TUI, so interrupt no-ops.
    const session = await startCodex({ cwd });
    expect(session.status).toBe("running");
    await session.interrupt();
    expect(ptys[0]!.writes).toEqual([]);
  });
});
