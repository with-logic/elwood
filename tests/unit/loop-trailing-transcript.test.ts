/** Native facades isolate scheduled loop transcript tails after rendered readiness (PRD §5.8, C-API-48). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-API-48 %s active loop drains after ready before caller dispatch", async (agent) => {
  const harness = agent === "claude" ? claude : codex;
  harness.installFakes();
  const cwd = harness.tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const facade = agent === "claude" ? new ClaudeSession({ cwd }) : new CodexSession({ cwd });
  let result: Promise<unknown> | undefined;
  try {
    const live: ElwoodAgentSession = await facade.start();
    const pty = harness.ptys[0]!;
    const hook = (fields: Record<string, unknown>) =>
      pty.dispatchHook(live.elwoodSessionId, {
        session_id: `${agent}-1`,
        cwd,
        transcript_path: transcript,
        model: "gpt-5.3-codex",
        ...fields,
      });
    const append = (text: string) =>
      appendFileSync(
        transcript,
        `${JSON.stringify(
          agent === "claude"
            ? { type: "assistant", message: { content: [{ type: "text", text }] } }
            : {
                type: "response_item",
                payload: {
                  type: "message",
                  role: "assistant",
                  phase: "final_answer",
                  content: [{ type: "output_text", text }],
                },
              },
        )}\n`,
      );
    vi.useFakeTimers();
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    if (agent === "claude")
      await hook({
        hook_event_name: "InstructionsLoaded",
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      });
    await vi.advanceTimersByTimeAsync(500);
    const send = vi.spyOn(live, "sendMessage");
    let fired = false;
    live.on("loop", (event) => {
      if (event.kind === "fired") fired = true;
    });
    await facade.createLoop({ mode: "fixed", intervalMs: 60_000, message: "check" });
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.waitFor(() => expect(fired).toBe(true));
    result = facade.send("check").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    let sawReady = false;
    live.on("status", ({ status }) => {
      if (status === "ready") sawReady = true;
    });
    await hook({ hook_event_name: "UserPromptSubmit", turn_id: "loop", prompt: "check" });
    pty.emitData(
      agent === "claude"
        ? "\u001b[2J\u001b[H❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents"
        : "\u001b[2J\u001b[H• Working (1s • esc to interrupt)\r\n› ",
    );
    await vi.advanceTimersByTimeAsync(50);
    pty.emitData(
      agent === "claude"
        ? "\u001b[2J\u001b[H❯ \r\n  ⏵⏵ bypass permissions · ← for agents"
        : "\u001b[2J\u001b[H■ Conversation interrupted\r\n› ",
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(sawReady).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await hook({
      hook_event_name: "Stop",
      turn_id: "loop",
      stop_hook_active: false,
      last_assistant_message: "LOOP",
    });
    // The oracle overrides quiet settlement even when the transcript takes longer to arrive.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(send).not.toHaveBeenCalled();
    append("LOOP");
    // Polling crosses real filesystem awaits despite the fake clock.
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 5_000 });
    let submitted = false;
    void send.mock.results[0]!.value.then(() => {
      submitted = true;
    });
    await vi.waitFor(() => expect(submitted).toBe(true));
    append("CALLER");
    await hook({
      hook_event_name: "Stop",
      turn_id: "caller",
      stop_hook_active: false,
      last_assistant_message: "CALLER",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toBe("CALLER");
  } finally {
    vi.useRealTimers();
    await facade.close();
    await result;
  }
});
