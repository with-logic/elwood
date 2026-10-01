/** Expired Stop input keeps its async timeout rejection after teardown (C-HOOK-04). */
import { afterEach, expect, test } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "sendPrompt",
    "sendMessage",
    "sendGuidance",
  ] as const)(`C-HOOK-04 ${agent} expired %s rejects asynchronously before terminal-state checks`, async (method) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const release = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<{ synchronous: boolean; error: unknown }>();
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      hooks: {
        Stop: () => {
          void release.promise.then(async () => {
            let pending: Promise<void>;
            try {
              pending = session[method]("expired input");
            } catch (error) {
              outcome.resolve({ synchronous: true, error });
              return;
            }
            try {
              await pending;
              outcome.resolve({ synchronous: false, error: undefined });
            } catch (error) {
              outcome.resolve({ synchronous: false, error });
            }
          });
        },
      },
    });
    const pty = helper.ptys[0]!;
    try {
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        turn_id: "first",
        stop_hook_active: false,
      });
      await session.teardown();
      release.resolve();
      expect(await outcome.promise).toMatchObject({
        synchronous: false,
        error: { code: "wait_timeout" },
      });
      await expect(session[method]("ordinary closed input")).rejects.toMatchObject({
        code: "session_not_running",
      });
      expect(pty.writes.some((value) => value.includes("expired input"))).toBe(false);
    } finally {
      release.resolve();
      await session.teardown();
    }
  });
}
