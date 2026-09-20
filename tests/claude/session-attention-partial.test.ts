/** Incomplete composer redraws cannot release an attention hold (C-ATTN-02, C-API-28). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  false,
  true,
])("C-ATTN-02 caret-only redraw after working clearance=%s keeps input held", async (working) => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const paint = async (text: string) => {
    ptys[0]!.emitData(frame(text));
    await session.terminal.settled();
  };
  try {
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
      session_id: "claude-partial",
      cwd,
    });
    await paint("Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel");
    expect(session.status).toBe("blocked");
    const queued = session.sendMessage("after complete idle");
    void queued.catch(() => undefined);
    if (working) await paint("esc to interrupt\r\n❯ ");
    const heldStatus = working ? "running" : "blocked";
    expect(session.status).toBe(heldStatus);
    const statuses: string[] = [];
    session.on("status", (event) => statuses.push(event.status));
    await paint("❯ ");
    expect(session.status).toBe(heldStatus);
    expect(statuses).not.toContain("ready");
    expect(ptys[0]!.writes).toEqual([]);
    await paint(tty(claudeComposer));
    await queued;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after complete idle\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});
