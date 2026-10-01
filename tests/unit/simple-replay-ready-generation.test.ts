/** A ready event before replay cannot release a still-running replay turn (C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import {
  claudeComposer,
  claudeTty,
  codexSmallComposer,
  codexTty,
} from "../fixtures/trust-composer.ts";

function paintEmpty(agent: "claude" | "codex", pty: { emitData(data: string): void }): void {
  pty.emitData(
    `\u001b[2J\u001b[H${agent === "claude" ? claudeTty(claudeComposer) : codexTty(codexSmallComposer)}`,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    false,
    true,
  ])(`C-API-48 ${agent} replay running retires earlier ready; ready after failure=%s`, async (lateReady) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const facade =
      agent === "claude"
        ? new ClaudeSession({ cwd, initialSize: { cols: 200, rows: 32 } })
        : new CodexSession({ cwd, initialSize: { cols: 200, rows: 32 } });
    const raw = await facade.start();
    if (!(raw instanceof AgentSessionBase)) throw new Error("Expected real adapter session");
    const pty = helper.ptys[0]!;
    const send = vi.spyOn(raw, "sendMessage");
    let first: Promise<string> | undefined;
    let next: Promise<string> | undefined;
    try {
      if (agent === "claude") {
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "InstructionsLoaded",
          session_id: "claude-1",
          cwd,
          file_path: "/tmp/CLAUDE.md",
          memory_type: "Project",
          load_reason: "session_start",
        });
      } else await codex.becomeReady(raw.elwoodSessionId, cwd);
      await expect.poll(() => raw.status).toBe("ready");
      vi.useFakeTimers();
      first = facade.send("first", { timeoutMs: 4_300 });
      const failed = expect(first).rejects.toMatchObject({ code: "wait_timeout" });
      next = facade.send("next");
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(200);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      paintEmpty(agent, pty);
      await vi.advanceTimersByTimeAsync(1_000);
      // Initial readiness without a submit hook is the swallowed-paste recovery trigger.
      raw.submitEvidence("hook_turn_ended");
      await vi.advanceTimersByTimeAsync(2_160);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(2);
      expect(raw.status).toBe("running");
      if (lateReady) {
        await vi.advanceTimersByTimeAsync(1_200);
        await failed;
        raw.submitEvidence("hook_turn_ended");
        expect(raw.status).toBe("ready");
      }
      const acceptance = pty.dispatchHook(raw.elwoodSessionId, {
        hook_event_name: "UserPromptSubmit",
        session_id: `${agent}-1`,
        cwd,
        prompt: "first",
        turn_id: "replayed-turn",
      });
      let accepted = false;
      void acceptance.then(() => {
        accepted = true;
      });
      await vi.waitFor(() => expect(accepted).toBe(true));
      await acceptance;
      if (lateReady) {
        const screen =
          agent === "codex"
            ? "• Working (3s • esc to interrupt)\r\n› "
            : "❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents";
        pty.emitData(`\u001b[2J\u001b[H${screen}`);
        await vi.advanceTimersByTimeAsync(100);
        expect(raw.status).toBe("running");
      }
      await vi.advanceTimersByTimeAsync(2_000);
      await failed;
      expect(raw.status).toBe("running");
      expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(["first", "first"]);
      // Generic readiness cannot retire an owned Codex generation.
      raw.submitEvidence("hook_turn_ended");
      if (agent === "codex") {
        await vi.advanceTimersByTimeAsync(100);
        expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(["first", "first"]);
        paintEmpty(agent, pty);
        await vi.advanceTimersByTimeAsync(100);
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "Stop",
          session_id: "codex-1",
          cwd,
          turn_id: "replayed-turn",
          stop_hook_active: false,
          last_assistant_message: "",
        });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(["first", "first", "next"]);
    } finally {
      vi.useRealTimers();
      await facade.close();
      await Promise.allSettled([first, next]);
    }
  });
}

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} timeout cancels held replay before the successor can write`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const facade =
      agent === "claude"
        ? new ClaudeSession({ cwd, initialSize: { cols: 200, rows: 32 } })
        : new CodexSession({ cwd, initialSize: { cols: 200, rows: 32 } });
    const raw = await facade.start();
    if (!(raw instanceof AgentSessionBase)) throw new Error("Expected real adapter session");
    const pty = helper.ptys[0]!;
    const send = vi.spyOn(raw, "sendMessage");
    let next: Promise<string> | undefined;
    try {
      raw.submitEvidence("initial_ready");
      vi.useFakeTimers();
      const first = facade.send("first", { timeoutMs: 4_300 });
      const failed = expect(first).rejects.toMatchObject({ code: "wait_timeout" });
      next = facade.send("next");
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(200);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      paintEmpty(agent, pty);
      await vi.advanceTimersByTimeAsync(1_000);
      raw.inputBlocking = true;
      raw.submitEvidence("hook_turn_ended");
      await vi.advanceTimersByTimeAsync(2_160);
      expect(send).toHaveBeenCalledTimes(2);
      expect(pty.writes.filter((value) => value.includes("first"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await failed;
      if (agent === "codex") {
        expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(["first", "first"]);
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "UserPromptSubmit",
          session_id: "codex-1",
          cwd,
          turn_id: "held-replay",
          prompt: "first",
        });
        raw.inputBlocking = false;
        paintEmpty(agent, pty);
        await vi.advanceTimersByTimeAsync(100);
        await pty.dispatchHook(raw.elwoodSessionId, {
          hook_event_name: "Stop",
          session_id: "codex-1",
          cwd,
          turn_id: "held-replay",
          stop_hook_active: false,
          last_assistant_message: "",
        });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(["first", "first", "next"]);
      raw.inputBlocking = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(pty.writes.filter((value) => value.includes("first"))).toHaveLength(1);
      expect(pty.writes.filter((value) => value.includes("next"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await facade.close();
      await Promise.allSettled([next]);
    }
  });
}
