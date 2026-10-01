/** Stop callbacks cannot complete a newer physical submission (C-HOOK-11/15). */
import { afterEach, expect, test, vi } from "vitest";
import { composerClearKeys } from "../../src/core/input/constants.ts";
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

const modes = ["awaited", "event", "blocked", "failed-open", "failed-input", "ordinary"] as const;
const cases = [
  ...modes.map((mode) => ({ mode, method: "sendPrompt" as const })),
  { mode: "awaited" as const, method: "sendMessage" as const },
  { mode: "awaited" as const, method: "sendGuidance" as const },
];

for (const agent of ["claude", "codex"] as const) {
  test.each(
    cases,
  )(`C-HOOK-11 C-HOOK-15 ${agent} $mode/$method Stop preserves submission ownership`, async ({
    mode,
    method,
  }) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    let handleStop: () => Promise<{ decision: "block"; reason: string } | undefined> = async () =>
      undefined;
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      hooks: { Stop: () => handleStop() },
    });
    const pty = helper.ptys[0]!;
    const stop = () =>
      pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "turn-1",
        stop_hook_active: false,
      });
    let callbackEntered = false;
    let callbackFinished = false;
    let next: Promise<void> | undefined;
    const submitNext = async () => {
      callbackEntered = true;
      await session[method]("next");
      callbackFinished = true;
    };
    try {
      vi.useFakeTimers();
      const first = session.sendPrompt("first");
      await vi.advanceTimersByTimeAsync(200);
      await first;
      if (method !== "sendPrompt") {
        // Queued message and guidance input can submit inside Stop only once ready.
        const initialStop = stop();
        await vi.advanceTimersByTimeAsync(200);
        await initialStop;
        expect(session.status).toBe("ready");
      }
      if (mode === "failed-input") {
        pty.failOnWrite = "\r";
        const write = pty.write.bind(pty);
        vi.spyOn(pty, "write").mockImplementation((value) => {
          write(value);
          if (value === composerClearKeys)
            pty.emitData(
              agent === "claude" ? claudeTty(claudeComposer) : codexTty(codexSmallComposer),
            );
        });
      }
      if (mode === "event") {
        const source: {
          on(
            event: "hook",
            handler: (event: { readonly hook_event_name: string }) => void,
          ): unknown;
        } = session;
        source.on("hook", (event) => {
          if (event.hook_event_name === "Stop" && !callbackEntered) next = submitNext();
        });
      } else if (mode !== "ordinary") {
        handleStop = async () => {
          await submitNext();
          if (mode === "failed-open") throw new Error("caller Stop failed after submission");
          return mode === "blocked" ? { decision: "block", reason: "continue" } : undefined;
        };
      }
      const completed = stop();
      if (mode !== "ordinary") await vi.waitFor(() => expect(callbackEntered).toBe(true));
      await vi.advanceTimersByTimeAsync(200);
      const reply = await completed;
      await next;
      const submittedNext = mode !== "ordinary" && mode !== "failed-input";
      expect(callbackFinished).toBe(submittedNext);
      expect(session.status).toBe(submittedNext ? "running" : "ready");
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(submittedNext ? 2 : 1);
      if (mode === "failed-input") {
        expect(pty.writes).toContain(composerClearKeys);
        expect(session.terminal.snapshot().text).toContain(
          agent === "claude" ? 'Try "fix typecheck errors"' : "Ask Codex to do anything",
        );
      }
      if (mode === "blocked") expect(JSON.parse(reply.stdout)).toMatchObject({ decision: "block" });
      else expect(reply).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      if (submittedNext) {
        const later = session.sendMessage("later");
        void later.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(200);
        expect(pty.writes.some((value) => value.includes("later"))).toBe(false);
        handleStop = async () => undefined;
        await stop();
        await vi.advanceTimersByTimeAsync(200);
        await later;
        expect(pty.writes.some((value) => value.includes("later"))).toBe(true);
      }
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
