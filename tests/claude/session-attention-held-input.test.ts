/** Held submission and startup readiness never release a busy turn (C-ATTN-02, PRD §5.3). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const approval = "Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel";
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;
const working = "esc to interrupt\r\n❯ ";
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

test("C-ATTN-02 a prompt held by a dialog reports running when its Enter finally dispatches", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
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
    ptys[0]!.emitData(frame(approval));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const prompt = session.sendPrompt("held first prompt");
    const followup = session.sendMessage("queued second prompt");
    void prompt.catch(() => undefined);
    void followup.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(frame(claudeTty(claudeComposer)));
    await session.terminal.settled();
    await prompt;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.status).toBe("running");
    expect(ptys[0]!.writes).toEqual([paste("held first prompt"), "\r"]);
    ptys[0]!.emitData(frame(working));
    await session.terminal.settled();
    ptys[0]!.emitData(frame(claudeTty(claudeComposer)));
    await session.terminal.settled();
    await followup;
    expect(ptys[0]!.writes).toEqual([
      paste("held first prompt"),
      "\r",
      paste("queued second prompt"),
      "\r",
    ]);
  } finally {
    await session.stop();
  }
});

test("C-ATTN-02 deferred initial readiness waits through working clearance", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const statuses: string[] = [];
  try {
    ptys[0]!.emitData(frame(approval));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const followup = session.sendMessage("after active work");
    void followup.catch(() => undefined);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    session.on("status", (event) => statuses.push(event.status));
    ptys[0]!.emitData(frame(""));
    await session.terminal.settled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.status).toBe("blocked");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(frame(working));
    await session.terminal.settled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.status).toBe("running");
    expect(statuses).toEqual(["running"]);
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(frame(claudeTty(claudeComposer)));
    await session.terminal.settled();
    await followup;
    expect(ptys[0]!.writes).toEqual([paste("after active work"), "\r"]);
  } finally {
    await session.stop();
  }
});
