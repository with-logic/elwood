/** Ergonomic initial input owns timeout and cancellation through physical Enter (C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-48 ${agent} initial timeout starts at Enter and failure retains native boundary`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const facade = agent === "claude" ? new ClaudeSession({ cwd }) : new CodexSession({ cwd });
    const raw = await facade.start();
    if (!(raw instanceof AgentSessionBase)) throw new Error("Expected real adapter session");
    let first: Promise<string> | undefined;
    let next: Promise<string> | undefined;
    try {
      raw.submitEvidence("initial_ready");
      raw.inputBlocking = true;
      vi.useFakeTimers();
      const send = vi.spyOn(raw, "sendMessage");
      first = facade.send("first", { timeoutMs: 200 });
      let rejected = false;
      void first.catch(() => {
        rejected = true;
      });
      next = facade.send("next");
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rejected).toBe(false); // a queued turn has no whole-turn deadline yet
      let inputSettled = false;
      void send.mock.results[0]!.value.then(
        () => {
          inputSettled = true;
        },
        () => {
          inputSettled = true;
        },
      );
      expect(helper.ptys[0]!.writes).not.toContain("\r");
      raw.inputBlocking = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(helper.ptys[0]!.writes.filter((write) => write === "\r")).toHaveLength(1);
      expect(raw.status).toBe("running");
      expect(inputSettled).toBe(false);
      // No fresh empty frame: input ownership is still pending when its timer fails.
      // A dialog defers composer clearing without stranding physical cancellation.
      raw.inputBlocking = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rejected).toBe(true);
      await expect(first).rejects.toMatchObject({ code: "wait_timeout" });
      expect(inputSettled).toBe(true);
      expect(send.mock.calls.map(([prompt]) => prompt)).toEqual(["first"]);
      expect(raw.status).toBe("running");
    } finally {
      vi.useRealTimers();
      await facade.close();
      await Promise.allSettled([first, next]);
    }
  });
}
