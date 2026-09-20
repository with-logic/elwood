/**
 * Codex status-aware intervention conformance (PRD §5.3/§5.7, C-API-37):
 * guidance is startup/block safe, immediate during turns, and terminal-aware.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, tty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi guidance", () => {
  test("C-API-37 queues at startup, then overtakes a running turn through Enter", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const startup = session.sendGuidance("startup-safe");
    expect(ptys[0]!.writes).toEqual([]);
    await becomeReady(session.elwoodSessionId, cwd);
    await startup;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~startup-safe\u001b[201~", "\r"]);

    const waiting = session.sendMessage("wait-for-ready");
    let settled = false;
    const urgent = session.sendGuidance("enter-running-turn").then(() => {
      settled = true;
    });
    await expect.poll(() => ptys[0]!.writes.length).toBe(3);
    expect(settled).toBe(false);
    await urgent;
    expect(ptys[0]!.writes.slice(-2)).toEqual(["\u001b[200~enter-running-turn\u001b[201~", "\r"]);
    ptys[0]!.emitData("\u001b[2J\u001b[H■ Conversation interrupted\r\n› ");
    await waiting;
    expect(ptys[0]!.writes.slice(-2)).toEqual(["\u001b[200~wait-for-ready\u001b[201~", "\r"]);
  });

  test("C-API-37 guidance waits while an approval dialog blocks Codex", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await becomeReady(session.elwoodSessionId, cwd);
    ptys[0]!.emitData(
      "\u001b[2J\u001b[HWould you like to run the following command?\r\n $ rm build\r\n › 1. Yes (y)\r\n Press enter to confirm or esc to cancel\r\n",
    );
    await expect.poll(() => session.status).toBe("blocked");
    const guidance = session.sendGuidance("after-human-decision");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(codexComposer)}`);
    await guidance;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after-human-decision\u001b[201~", "\r"]);
  });

  test("C-API-25 C-API-37 stopped Codex rejects guidance asynchronously", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await session.stop();
    await expect(session.sendGuidance("late")).rejects.toMatchObject({
      code: "session_not_running",
    });
  });
});
