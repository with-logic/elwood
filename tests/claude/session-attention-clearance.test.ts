/** Working dialog clearance keeps physical queued input suspended (C-ATTN-02). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const approval = "Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel";
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  "caller",
  "rendered",
])("C-ATTN-02 %s work cannot release queued input when a dialog clears into more work", async (start) => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const statuses: string[] = [];
  try {
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await expect.poll(() => session.status).toBe("ready");
    if (start === "caller") {
      await session.sendMessage("first turn");
      expect(
        session.statusDecisions().filter((event) => event.evidence === "caller_submitted"),
      ).toHaveLength(1);
    }
    ptys[0]!.emitData(frame(approval));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const before = [...ptys[0]!.writes];
    session.on("status", (event) => statuses.push(event.status));
    const queued = session.sendMessage("queued follow-up");
    void queued.catch(() => undefined);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    ptys[0]!.emitData(frame(`${approval}\r\nesc to interrupt`));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual(before);
    ptys[0]!.emitData(frame("esc to interrupt\r\n❯ "));
    await session.terminal.settled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual(before);
    expect(session.status).toBe("running");
    expect(statuses).toEqual(["running"]);
    ptys[0]!.emitData(frame(tty(claudeComposer)));
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
