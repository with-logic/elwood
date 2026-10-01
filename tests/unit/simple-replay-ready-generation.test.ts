/** A ready event before replay cannot release a still-running replay turn (C-API-48). */

import { afterEach, expect, test, vi } from "vitest";
import { AgentSessionBase } from "../../src/runtime/session/base.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";

afterEach(() => {
  vi.useRealTimers();
  resetAdapters();
});

for (const agent of ["claude", "codex"] as const) {
  test.each([
    false,
    true,
  ])(`C-API-48 ${agent} replay running retires earlier ready; ready after failure=%s`, async (lateReady) => {
    const { helper, cwd, facade } = createFacadeFixture(agent, {
      initialSize: { cols: 200, rows: 32 },
    });
    const raw = await facade.start();
    if (!(raw instanceof AgentSessionBase)) throw new Error("Expected real adapter session");
    const pty = helper.ptys[0]!;
    const native = nativeHooks(agent, raw, cwd, pty);
    const send = vi.spyOn(raw, "sendMessage");
    let first: Promise<string> | undefined;
    let next: Promise<string> | undefined;
    try {
      await native.ready();
      await expect.poll(() => raw.status).toBe("ready");
      vi.useFakeTimers();
      first = facade.send("first", { timeoutMs: 4_300 });
      const failed = expect(first).rejects.toMatchObject({ code: "wait_timeout" });
      next = facade.send("next");
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(200);
      expect(pty.writes.filter((value) => value === "\r")).toHaveLength(1);
      pty.emitData(emptyComposer(agent));
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
      const acceptance = native.submit("replayed-turn", "first");
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
        pty.emitData(emptyComposer(agent));
        await vi.advanceTimersByTimeAsync(100);
        await nativeHooks("codex", raw, cwd, pty).stop("replayed-turn");
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
    const { helper, cwd, facade } = createFacadeFixture(agent, {
      initialSize: { cols: 200, rows: 32 },
    });
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
      pty.emitData(emptyComposer(agent));
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
        await nativeHooks("codex", raw, cwd, pty).submit("held-replay", "first");
        raw.inputBlocking = false;
        pty.emitData(emptyComposer(agent));
        await vi.advanceTimersByTimeAsync(100);
        await nativeHooks("codex", raw, cwd, pty).stop("held-replay");
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
