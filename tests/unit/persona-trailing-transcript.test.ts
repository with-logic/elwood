/** Native facades isolate persona transcript tails after rendered readiness (PRD §5.8, C-API-48). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-API-48 %s persona drains after ready before caller dispatch", async (agent) => {
  const harness = agent === "claude" ? claude : codex;
  harness.installFakes();
  const cwd = harness.tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const facade =
    agent === "claude"
      ? new ClaudeSession({ cwd, persona: "persona" })
      : new CodexSession({ cwd, persona: "persona" });
  const result = facade.send("caller").catch((error: unknown) => error);
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
    expect(pty.writes).toContain("\r");
    let sawReady = false;
    live.on("status", ({ status }) => {
      if (status === "ready") sawReady = true;
    });
    await hook({ hook_event_name: "UserPromptSubmit", turn_id: "persona", prompt: "persona" });
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
    expect(pty.writes.some((write) => write.includes("caller"))).toBe(false);
    await hook({
      hook_event_name: "Stop",
      turn_id: "persona",
      stop_hook_active: false,
      last_assistant_message: "PERSONA",
    });
    // The oracle overrides quiet settlement even when the transcript takes longer to arrive.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pty.writes.some((write) => write.includes("caller"))).toBe(false);
    append("PERSONA");
    // Advancing fake time starts polls but cannot finish their asynchronous filesystem reads.
    await vi.waitFor(
      () => expect(pty.writes.some((write) => write.includes("caller"))).toBe(true),
      { timeout: 5_000 },
    );
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
