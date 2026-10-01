/** Stop failure diagnostics publish before lifecycle readiness (C-HOOK-11/15, C-HOOK-22). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-HOOK-22 ${agent} Stop diagnostic input precedes readiness notification`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const pty = helper.ptys[0]!;
    const events: {
      on(name: "hook", listener: (event: { hook_event_name: string }) => void): unknown;
      on(name: "warning", listener: (event: { code: string }) => void): unknown;
      on(name: "status", listener: (event: { status: string }) => void): unknown;
    } = session;
    const order: string[] = [];
    let next: Promise<void> | undefined;
    let nextDone = false;
    try {
      vi.useFakeTimers();
      let firstDone = false;
      const first = session.sendPrompt("first").then(() => {
        firstDone = true;
      });
      await vi.waitFor(() => expect(firstDone).toBe(true));
      await first;
      events.on("hook", (event) => {
        if (event.hook_event_name === "Stop") throw new Error("observer failed");
      });
      events.on("warning", (event) => {
        if (event.code !== "hook_observer_failed") return;
        order.push(`warning:${session.status}`);
        next = session.sendPrompt("diagnostic input").then(() => {
          nextDone = true;
        });
      });
      events.on("status", (event) => {
        if (event.status === "ready") order.push("ready");
      });
      let stopped = false;
      const reply = pty
        .dispatchHook(session.elwoodSessionId, {
          hook_event_name: "Stop",
          session_id: `${agent}-1`,
          cwd,
          turn_id: "first",
          stop_hook_active: false,
        })
        .then((value) => {
          stopped = true;
          return value;
        });
      await vi.waitFor(() => expect(stopped && nextDone).toBe(true));
      await reply;
      await next;
      expect(order[0]).toBe("warning:running");
      expect(order.filter((entry) => entry.startsWith("warning"))).toHaveLength(1);
      expect(session.status).toBe("running");
      expect(pty.writes.some((value) => value.includes("diagnostic input"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await session.teardown();
    }
  });
}
