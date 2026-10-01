/** Real facade and loop scheduling share one caller boundary (PRD §5.8/§5.9, C-API-48). */

import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import * as codex from "../codex/helpers.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { createFacadeFixture, resetAdapters } from "../fixtures/owned-turn/session.ts";

afterEach(() => {
  vi.useRealTimers();
  resetAdapters();
});

test.each([
  { agent: "codex", queued: false },
  { agent: "codex", queued: true },
  { agent: "claude", queued: false },
  { agent: "claude", queued: true },
] as const)("C-API-48 $agent loops wait through caller recovery and queued successor=$queued", async ({
  agent,
  queued,
}) => {
  const {
    helper: harness,
    cwd,
    facade,
  } = createFacadeFixture(agent, { initialSize: { cols: 200, rows: 32 } });
  const { ptys } = harness;
  const confirmInput = async (enters: number) => {
    await vi.waitFor(() =>
      expect(ptys[0]!.writes.filter((write) => write === "\r")).toHaveLength(enters),
    );
    // Awaited ergonomic writes need actual post-Enter empty-input evidence.
    ptys[0]!.emitData(emptyComposer(agent));
    await vi.advanceTimersByTimeAsync(1_000);
  };
  let pending: Promise<unknown> | undefined;
  let firstSettled = false;
  let successor: Promise<unknown> | undefined;
  try {
    const live: ElwoodAgentSession = await facade.start();
    if (agent === "codex") await codex.becomeReady(live.elwoodSessionId, cwd);
    else {
      await ptys[0]!.dispatchHook(live.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "claude-1",
        cwd,
        source: "startup",
      });
      await ptys[0]!.dispatchHook(live.elwoodSessionId, {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-1",
        cwd,
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      });
    }
    await expect.poll(() => live.status).toBe("ready");
    const send = vi.spyOn(live, "sendMessage");
    vi.useFakeTimers();
    await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    pending = facade
      .send("check")
      .catch((error: unknown) => error)
      .finally(() => {
        firstSettled = true;
      });
    if (queued) successor = facade.send("successor").catch((error: unknown) => error);
    await confirmInput(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(send).toHaveBeenCalledOnce();
    // A method call does not prove the initial Enter completed before native output.
    let initialSubmitted = false;
    void send.mock.results[0]!.value.then(
      () => {
        initialSubmitted = true;
      },
      () => undefined,
    );
    await vi.waitFor(() => expect(initialSubmitted).toBe(true), { timeout: 3000 });
    const paint = async (text: string) => {
      const screen =
        agent === "codex"
          ? `${text}\r\n› `
          : `❯ \r\n  ⏵⏵ bypass permissions · ${text.startsWith("• Working") ? "esc to interrupt · " : ""}← for agents`;
      ptys[0]!.emitData(`\u001b[2J\u001b[H${screen}`);
      await vi.advanceTimersByTimeAsync(100);
    };
    await paint("• Working (3s • esc to interrupt)");
    await paint("■ Conversation interrupted");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(fired).toBe(false);
    let replaySubmitted = false;
    void send.mock.results[1]!.value.then(
      () => {
        replaySubmitted = true;
      },
      () => undefined,
    );
    await confirmInput(2);
    await vi.waitFor(() => expect(replaySubmitted).toBe(true));
    await ptys[0]!.dispatchHook(live.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: `${agent}-1`,
      cwd,
      prompt: "check",
      turn_id: "caller-turn",
    });
    await paint("• Working (3s • esc to interrupt)");
    await paint("■ Conversation interrupted");
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect(firstSettled).toBe(true);
    await expect(pending).resolves.toBe("");
    if (queued) {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      expect(fired).toBe(false);
      let submitted = false;
      void send.mock.results[2]!.value.then(
        () => {
          submitted = true;
        },
        () => undefined,
      );
      await confirmInput(3);
      await vi.waitFor(() => expect(submitted).toBe(true));
      await ptys[0]!.dispatchHook(live.elwoodSessionId, {
        hook_event_name: "UserPromptSubmit",
        session_id: `${agent}-1`,
        cwd,
        prompt: "successor",
        turn_id: "successor-turn",
      });
      await paint("• Working (3s • esc to interrupt)");
      await paint("■ Conversation interrupted");
      await vi.advanceTimersByTimeAsync(2100);
      await expect(successor).resolves.toBe("");
    }
    await vi.waitFor(() => expect(fired).toBe(true));
    expect(send).toHaveBeenCalledTimes(queued ? 3 : 2);
  } finally {
    vi.useRealTimers();
    await facade.close();
    await pending;
    await successor;
  }
});
