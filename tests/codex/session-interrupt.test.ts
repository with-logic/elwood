/**
 * Conformance tests for Codex turn interrupts.
 * Covers PRD §5.7 and C-API-38.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const stopHook = (cwd: string) => ({
  hook_event_name: "Stop",
  session_id: "codex-1",
  cwd,
  model: "gpt-5.3-codex",
  turn_id: "turn-1",
  stop_hook_active: false,
});

describe("CodexSession interrupt", () => {
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
});
