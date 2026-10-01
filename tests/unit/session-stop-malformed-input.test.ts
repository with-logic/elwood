/** Recognized malformed Stop diagnostics expire public input on the exact session (C-HOOK-04). */
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
    "Stop",
    "NotKnown",
  ])(`C-HOOK-04 ${agent} malformed %s diagnostic continuations keep their own admission policy`, async (hookName) => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const session = await (agent === "claude" ? startClaude : startCodex)({
      cwd: helper.tempDir(),
    });
    const pty = helper.ptys[0]!;
    const release = Promise.withResolvers<void>();
    const results: Promise<unknown>[] = [];
    const capture = () => {
      results.push(
        release.promise
          .then(() => session.sendPrompt("diagnostic input"))
          .then(
            () => "sent",
            (error: unknown) => error,
          ),
      );
    };
    const events: {
      on(name: "hookError", listener: () => void): unknown;
      on(name: "activity", listener: (event: { readonly kind: string }) => void): unknown;
    } = session;
    events.on("hookError", capture);
    events.on("activity", (event) => {
      if (event.kind === "hook_error") capture();
    });
    try {
      const reply = await pty.dispatchHook(session.elwoodSessionId, { hook_event_name: hookName });
      expect(reply.exitCode).toBe(0);
      expect(results).toHaveLength(2);
      release.resolve();
      const outcomes = await Promise.all(results);
      for (const outcome of outcomes) {
        if (hookName === "Stop") expect(outcome).toMatchObject({ code: "wait_timeout" });
        else expect(outcome).toBe("sent");
      }
      expect(pty.writes.filter((text) => text === "\r")).toHaveLength(hookName === "Stop" ? 0 : 2);
      await session.sendPrompt("unrelated caller");
      expect(pty.writes.some((text) => text.includes("unrelated caller"))).toBe(true);
    } finally {
      release.resolve();
      await session.teardown();
    }
  });
}
