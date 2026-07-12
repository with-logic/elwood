/**
 * Claude status-aware intervention conformance (PRD §5.3, C-API-37): guidance
 * is startup/block safe, overtakes active turns, and settles after Enter.
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

describe("ClaudeSession guidance", () => {
  test("C-API-37 queues at startup, then overtakes a running turn through Enter", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const startup = session.sendGuidance("startup-safe");
    expect(ptys[0]!.writes).toEqual([]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    await startup;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~startup-safe\u001b[201~", "\r"]);

    const waiting = session.sendMessage("wait-for-ready");
    let settled = false;
    const urgent = session.sendGuidance("enter-running-turn").then(() => {
      settled = true;
    });
    await expect.poll(() => ptys[0]!.writes.length).toBe(3);
    expect(settled).toBe(false);
    await session.sendKeys("\u001b");
    expect(settled).toBe(false);
    await urgent;
    expect(ptys[0]!.writes).toEqual([
      "\u001b[200~startup-safe\u001b[201~",
      "\r",
      "\u001b[200~enter-running-turn\u001b[201~",
      "\u001b",
      "\r",
    ]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
      stop_hook_active: false,
    });
    await waiting;
    expect(ptys[0]!.writes.slice(-2)).toEqual(["\u001b[200~wait-for-ready\u001b[201~", "\r"]);
  });

  test("C-API-37 guidance waits while a permission dialog blocks Claude", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    ptys[0]!.emitData(
      "Do you want to create elwood.txt?\r\n ❯ 1. Yes\r\n   3. No\r\n Esc to cancel\r\n",
    );
    await expect.poll(() => session.status).toBe("blocked");
    const guidance = session.sendGuidance("after-human-decision");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData("\u001b[2J\u001b[H❯ \r\n  ready again\r\n");
    await guidance;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after-human-decision\u001b[201~", "\r"]);
  });

  test("C-API-07 C-API-37 first-Enter failures reject public submissions", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    ptys[0]!.failOnWrite = "\r";
    await expect(session.sendPrompt("prompt-fails")).rejects.toThrow("terminal disposed");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
      stop_hook_active: false,
    });
    await expect(session.sendGuidance("guidance-fails")).rejects.toThrow("terminal disposed");
  });
});
