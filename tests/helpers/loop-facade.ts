/** Actual adapter facade fixture for ordered loop/caller boundaries (PRD §5.8/§5.9). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { asScreen, claudePicker, codexPickerCurrentIsDefault } from "./model-pickers.ts";

export async function loopFacade(agent: "claude" | "codex") {
  const harness = agent === "claude" ? claude : codex;
  harness.installFakes();
  const cwd = harness.tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const facade = agent === "claude" ? new ClaudeSession({ cwd }) : new CodexSession({ cwd });
  const live: ElwoodAgentSession = await facade.start();
  const pty = harness.ptys[0]!;
  let turn = "initial";
  const hook = (fields: Record<string, unknown>) =>
    pty.dispatchHook(live.elwoodSessionId, {
      session_id: `${agent}-1`,
      cwd,
      transcript_path: transcript,
      ...(agent === "codex" ? { turn_id: turn } : {}),
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
  await hook({ hook_event_name: "SessionStart", source: "startup", model: "gpt-5.3-codex" });
  if (agent === "claude")
    await hook({
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
  await vi.waitUntil(() => live.status === "ready");
  vi.useFakeTimers();
  const renderReady = async () => {
    pty.emitData(
      asScreen(
        agent === "claude"
          ? "❯ \n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents"
          : "• Working (1s • esc to interrupt)\n› ",
      ),
    );
    await vi.advanceTimersByTimeAsync(50);
    pty.emitData(
      asScreen(
        agent === "claude"
          ? "❯ \n  ⏵⏵ bypass permissions · ← for agents"
          : "■ Conversation interrupted\n› ",
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
  };
  const stop = async (text: string) => {
    await hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text });
    await renderReady();
  };
  const submitted = (prompt: string) => {
    turn = prompt;
    return hook({ hook_event_name: "UserPromptSubmit", prompt });
  };
  const picker = async () => {
    const from = pty.writes.length;
    const listing = facade.listModels({ timeoutMs: 5000 });
    void listing.catch(() => undefined);
    await vi.waitUntil(() => pty.writes.slice(from).join("").includes("/model\r"));
    pty.emitData(asScreen(agent === "claude" ? claudePicker : codexPickerCurrentIsDefault));
    await vi.waitUntil(() => pty.writes.includes("\u001b"));
    pty.emitData(asScreen(agent === "claude" ? "❯ " : "› "));
    let settled = false;
    void listing
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await vi.waitUntil(() => settled);
    return listing;
  };
  const close = async () => {
    vi.useRealTimers();
    await facade.close();
  };
  return { facade, live, pty, append, stop, submitted, picker, close, hook, renderReady };
}

export function resetLoopFacades(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
}
