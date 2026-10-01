/** Hook dispatch scopes internal context checks; this does not enforce input admission (§6/§7A). */
import { afterEach, expect, test } from "vitest";
import { assertStopInput } from "../../src/core/stop-input.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    "normal",
    "blocked",
    "timeout",
    "malformed",
    "unknown",
  ] as const)(`C-HOOK-04 ${agent} %s dispatch closes only its recognized Stop callback context`, async (mode) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const release = Promise.withResolvers<void>();
    const outcomes: Promise<unknown>[] = [];
    let owner: { readonly elwoodSessionId: string };
    const capture = () => {
      assertStopInput(owner);
      outcomes.push(
        release.promise.then(() => {
          try {
            assertStopInput(owner);
            return "open";
          } catch (error) {
            return error;
          }
        }),
      );
    };
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd,
      hookTimeoutMs: 5,
      hooks: {
        Stop: ():
          | undefined
          | { readonly decision: "block"; readonly reason: string }
          | Promise<undefined> => {
          capture();
          if (mode === "timeout") return release.promise.then(() => undefined);
          if (mode === "blocked") return { decision: "block" as const, reason: "retain" };
          return undefined;
        },
      },
    });
    owner = session;
    const events: {
      on(name: "hook", handler: (event: { readonly hook_event_name: string }) => void): unknown;
      on(name: "hookError", handler: () => void): unknown;
      on(name: "activity", handler: (event: { readonly hookEventName?: string }) => void): unknown;
    } = session;
    events.on("hook", (event) => {
      if (event.hook_event_name === "Stop") capture();
    });
    events.on("hookError", capture);
    events.on("activity", (event) => {
      if (event.hookEventName === "Stop" || event.hookEventName === "Unknown") capture();
    });
    try {
      const result = await helper.ptys[0]!.dispatchHook(
        session.elwoodSessionId,
        mode === "malformed" || mode === "unknown"
          ? { hook_event_name: mode === "malformed" ? "Stop" : "NotKnown" }
          : {
              hook_event_name: "Stop",
              session_id: `${agent}-1`,
              cwd,
              turn_id: "turn-1",
              stop_hook_active: false,
            },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        mode === "blocked" ? '{"decision":"block","reason":"retain"}\n' : "",
      );
      expect(outcomes.length).toBeGreaterThanOrEqual(mode === "unknown" ? 1 : 2);
      release.resolve();
      for (const outcome of await Promise.all(outcomes)) {
        if (mode === "unknown") expect(outcome).toBe("open");
        else expect(outcome).toMatchObject({ code: "wait_timeout" });
      }
      assertStopInput(session); // Unrelated callers remain outside the completed context.
    } finally {
      release.resolve();
      await session.teardown();
    }
  });
}
