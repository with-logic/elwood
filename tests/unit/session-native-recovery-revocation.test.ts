/** Recovery retries without native evidence and stops after a submission hook (C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import {
  claudeComposer,
  claudeTty,
  codexSmallComposer,
  codexTty,
} from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});
for (const agent of ["claude", "codex"] as const) {
  test.each([
    "fresh",
    "hook",
  ] as const)(`C-API-31 ${agent} recovery evidence=%s`, async (acceptance) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      initialSize: { cols: 200, rows: 35 },
    });
    const pty = helper.ptys[0]!;
    const payload = "probe prompt";
    const caret = agent === "claude" ? "❯" : "›";
    const chip = agent === "claude" ? "[Pasted text #1 +15 lines]" : payload;
    const draft = (agent === "claude" ? claudeComposer : codexSmallComposer).replace(
      new RegExp(`^${caret}.*$`, "m"),
      `${caret} ${chip}`,
    );
    const paint = () =>
      pty.emitData(`\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(draft)}`);
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((data) => {
      write(data);
      if (String(data).startsWith("\u001b[200~")) paint();
    });
    const userMessages: string[] = [];
    const activitySession: {
      on(event: "activity", handler: (event: ElwoodActivityEvent) => void): unknown;
    } = session;
    activitySession.on("activity", (event) => {
      if (event.kind === "user_message") userMessages.push(event.kind);
    });
    try {
      if (agent === "claude")
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "InstructionsLoaded",
          session_id: "claude-1",
          cwd,
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      else await codex.becomeReady(session.elwoodSessionId, cwd);
      await expect.poll(() => session.status).toBe("ready");
      vi.useFakeTimers();
      const sent = session.sendMessage(payload);
      await vi.advanceTimersByTimeAsync(200);
      await sent;
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      const before = session.terminal.snapshot().text;
      if (acceptance === "hook")
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "UserPromptSubmit",
          session_id: `${agent}-1`,
          cwd,
          model: "gpt-5.3-codex",
          turn_id: "turn-1",
          prompt: payload,
        });
      expect(userMessages).toHaveLength(acceptance === "hook" ? 1 : 0);
      expect(session.terminal.snapshot().text).toBe(before);
      paint();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(
        acceptance === "fresh" ? 2 : 1,
      );
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
