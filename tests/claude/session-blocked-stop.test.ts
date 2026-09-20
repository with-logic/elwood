/** Claude Stop preserves a visible permission prompt until clearance (C-ATTN-01/02). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const permission = "Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel";

test("C-ATTN-02 Claude Stop and the same permission repaint stay blocked until clearance", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const attention: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event.label);
  });
  try {
    await session.sendPrompt("busy");
    const before = [...ptys[0]!.writes];
    ptys[0]!.emitData(permission);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(session.status).toBe("blocked");
    ptys[0]!.emitData(`\u001b[2J\u001b[H${permission}`);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    expect(attention).toEqual(["claude-permission-dialog"]);
    expect(ptys[0]!.writes).toEqual(before);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await session.terminal.settled();
    expect(session.status).toBe("ready");
    expect(attention).toEqual(["claude-permission-dialog"]);
  } finally {
    await session.stop();
  }
});
