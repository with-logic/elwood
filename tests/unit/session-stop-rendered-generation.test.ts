/** Physical Stop input cannot inherit prior rendered completion (C-HOOK-11/15, C-TURN-04). */
import { afterEach, expect, test, vi } from "vitest";
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
    "idle",
    "retained-banner",
    "pending-banner",
    "fresh-banner",
    "write-working",
  ] as const)(`C-HOOK-11 C-TURN-04 ${agent} %s is scoped to physical Stop submission`, async (mode) => {
    async function settled<T>(phase: string, pending: Promise<T>): Promise<T> {
      let done = false;
      void pending.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      await vi.waitFor(() => expect(done, phase).toBe(true));
      return pending;
    }

    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    let handleStop = async () => {};
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      initialSize: { cols: 200, rows: 35 },
      hooks: {
        Stop: async () => {
          await handleStop();
          // Block the hook itself so main/branch attribution isolates rendered completion.
          return { decision: "block", reason: "new input owns completion" };
        },
      },
    });
    const pty = helper.ptys[0]!;
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const working = agent === "claude" ? "esc to interrupt" : "• Working (3s • esc to interrupt)";
    const banner =
      agent === "claude"
        ? "  ⎿  Interrupted· What should Claude do"
        : "■ Conversation interrupted - tell the model what to do.";
    const emit = (prefix: string) => {
      const composer =
        session.terminal.xterm.cols < 50
          ? agent === "claude"
            ? `${"─".repeat(42)}\n❯ \n${"─".repeat(42)}`
            : "› \n  gpt-5.6-sol low · /tmp/p"
          : idle;
      const frame =
        prefix === working && agent === "claude"
          ? composer.replace("← for agents", "esc to interrupt · ← for agents")
          : `${prefix}\n${composer}`;
      pty.emitData(`\u001b[2J\u001b[H${agent === "claude" ? claudeTty(frame) : codexTty(frame)}`);
    };
    const paint = async (prefix: string) => {
      emit(prefix);
      await vi.advanceTimersByTimeAsync(200);
    };
    try {
      if (agent === "claude") {
        await pty.dispatchHook(session.elwoodSessionId, {
          hook_event_name: "InstructionsLoaded",
          session_id: "claude-1",
          cwd,
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      } else await codex.becomeReady(session.elwoodSessionId, cwd);
      await expect.poll(() => session.status).toBe("ready");
      vi.useFakeTimers();
      const first = session.sendPrompt("first");
      await vi.advanceTimersByTimeAsync(200);
      await settled("first physical input", first);
      await paint(working);
      expect(session.status).toBe("running");
      if (mode === "retained-banner") await paint(banner);
      handleStop = async () => {
        if (mode === "pending-banner") {
          pty.emitData("\u001b[?2026h");
          await paint(banner);
        }
        await session.sendPrompt("next");
      };
      if (mode === "write-working") {
        const write = pty.write.bind(pty);
        let submitted = false;
        vi.spyOn(pty, "write").mockImplementation((value) => {
          write(value);
          if (value === "\r" && !submitted) {
            submitted = true;
            emit(working);
          }
        });
      }
      const stopped = pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "first",
        stop_hook_active: false,
      });
      await settled("Stop callback and reply", stopped);
      if (mode === "pending-banner") {
        pty.emitData("\u001b[?2026l");
        await vi.advanceTimersByTimeAsync(200);
      }
      const later = session.sendMessage("queued successor");
      void later.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(300);
      expect(session.status).toBe("running");
      expect(pty.writes.some((value) => value.includes("queued successor"))).toBe(false);
      if (mode === "idle") {
        await paint("");
        expect(pty.writes.some((value) => value.includes("queued successor"))).toBe(false);
        await paint(working);
        await paint("");
      } else if (mode === "retained-banner" || mode === "pending-banner") {
        await paint(banner);
        expect(pty.writes.some((value) => value.includes("queued successor"))).toBe(false);
        await paint("");
        await paint(banner);
      } else if (mode === "write-working") {
        await paint("");
      } else {
        // The captured narrow banner remains a completion signal without a Working footer.
        session.terminal.resize({ cols: 46, rows: 35 });
        await paint(banner);
      }
      await settled("queued successor", later);
      expect(pty.writes.some((value) => value.includes("queued successor"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
