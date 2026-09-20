/** Working dialog clearance keeps physical queued input suspended (C-ATTN-02). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const approval =
  "Would you like to run the following command?\r\n› 1. Yes\r\n  2. No\r\nPress enter to confirm or esc to cancel";
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  "caller",
  "rendered",
])("C-ATTN-02 %s work cannot release queued input when a dialog clears into more work", async (start) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const statuses: string[] = [];
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    if (start === "caller") await session.sendMessage("first turn");
    ptys[0]!.emitData(frame(approval));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const before = [...ptys[0]!.writes];
    session.on("status", (event) => statuses.push(event.status));
    const queued = session.sendMessage("queued follow-up");
    void queued.catch(() => undefined);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "old-turn",
      stop_hook_active: false,
    });
    ptys[0]!.emitData(frame(`${approval}\r\n• Working (3s • esc to interrupt)`));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual(before);
    ptys[0]!.emitData(frame("• Working (4s • esc to interrupt)\r\n› "));
    await session.terminal.settled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual(before);
    expect(session.status).toBe("running");
    expect(statuses).toEqual(["running"]);
    ptys[0]!.emitData(frame("› "));
    await session.terminal.settled();
    await queued;
    expect(statuses).toEqual(["running", "ready", "running"]);
    expect(ptys[0]!.writes.slice(before.length)).toEqual([
      "\u001b[200~queued follow-up\u001b[201~",
      "\r",
    ]);
  } finally {
    await session.stop();
  }
});
