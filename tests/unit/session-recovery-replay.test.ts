/** Startup/resume history cannot cancel a swallowed first Enter (C-API-31/C-TURN-03). */
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
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
    "startup",
    "resume",
    "current",
    "settled-resume",
    "resume-hook",
  ] as const)(`C-API-31 ${agent} recovery distinguishes %s native work`, async (mode) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    let session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const resumed = mode.includes("resume");
    if (resumed) {
      await helper.ptys[0]!.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: `${agent}-1`,
        cwd,
        source: "startup",
      });
      await session.stop();
      session = await (agent === "claude" ? resumeClaude : resumeCodex)({
        cwd,
        elwoodSessionId: session.elwoodSessionId,
      });
    }
    const pty = helper.ptys.at(-1)!;
    let accepted = 0;
    const activitySession: {
      on(event: "activity", handler: (event: ElwoodActivityEvent) => void): unknown;
    } = session;
    activitySession.on("activity", (event) => {
      if (event.kind === "user_message") accepted += 1;
    });
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const caret = agent === "claude" ? "❯" : "›";
    const payload = "probe prompt";
    const chip = agent === "claude" ? "[Pasted text #1 +15 lines]" : payload;
    const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${chip}`);
    const paint = (frame = draft, working = false) =>
      pty.emitData(
        `\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(frame)}\u001b]0;${working ? "⠋ Working" : "Ready"}\u0007`,
      );
    const write = pty.write.bind(pty);
    let enters = 0;
    vi.spyOn(pty, "write").mockImplementation((value) => {
      write(value);
      if (String(value).startsWith("\u001b[200~")) paint();
      if (value === "\r" && ++enters === 1 && mode !== "startup") paint(draft, true);
    });
    try {
      vi.useFakeTimers();
      if (mode === "startup") {
        paint("Starting native tools", true);
        await vi.advanceTimersByTimeAsync(50);
        await session.terminal.settled();
      }
      if (agent === "codex" && resumed) {
        paint(idle); // Native Codex does not emit SessionStart on resume.
        await vi.advanceTimersByTimeAsync(50);
        expect(session.status).toBe("ready");
      } else
        await pty.dispatchHook(
          session.elwoodSessionId,
          agent === "claude"
            ? {
                hook_event_name: "InstructionsLoaded",
                session_id: "claude-1",
                cwd,
                file_path: "/tmp/CLAUDE.md",
                memory_type: "Project",
                load_reason: "session_start",
              }
            : {
                hook_event_name: "SessionStart",
                session_id: "codex-1",
                cwd,
                source: resumed ? "resume" : "startup",
              },
        );
      if (mode === "settled-resume") {
        for (let count = 0; count < 6; count += 1) {
          paint(idle);
          await vi.advanceTimersByTimeAsync(50);
        }
      }
      const sent = session.sendMessage(payload);
      await vi.advanceTimersByTimeAsync(200);
      await sent;
      expect(enters).toBe(1);
      if (mode === "resume-hook")
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "UserPromptSubmit",
          session_id: `${agent}-1`,
          cwd,
          prompt: payload,
          turn_id: "turn-1",
        });
      expect(accepted).toBe(mode === "resume-hook" ? 1 : 0);
      paint();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(enters).toBe(mode === "startup" || mode === "resume" ? 2 : 1);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
