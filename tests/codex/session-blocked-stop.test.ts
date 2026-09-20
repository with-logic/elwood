/** A late Stop cannot clear an unchanged human prompt (PRD §5.3, C-ATTN-01/02). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const approval =
  "Would you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel";

test("C-ATTN-01 a late Stop preserves blocking until the unchanged prompt clears", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const attention: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(approval);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "old-turn",
      stop_hook_active: false,
    });
    ptys[0]!.emitData(`\u001b[2J\u001b[H${approval}`);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    expect(attention).toEqual(["codex-approval-dialog"]);
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData("\u001b[2J\u001b[H› ");
    await session.terminal.settled();
    expect(session.status).toBe("ready");
    expect(attention).toEqual(["codex-approval-dialog"]);
  } finally {
    await session.stop();
  }
});
