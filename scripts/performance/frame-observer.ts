/** Production frame classification for the parallel PTY probe (PRD §4.1/§5.3). */
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { observeRenderedFrame, type RenderedObservers } from "../../src/core/rendered-observers.ts";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ElwoodTerminal } from "../../src/terminal/headless.ts";

/**
 * Optional detection/replay work; native agent processes and hook traffic are excluded.
 * `benchmarkSessionId` is a synthetic Elwood session ID, never an agent conversation ID.
 * Throws on an unknown `ELWOOD_BENCH_AGENT`, so build it before spawning any PTY.
 */
export function frameObserver(benchmarkSessionId: string) {
  const agent = process.env["ELWOOD_BENCH_AGENT"];
  if (agent === undefined) return (_data: string, terminal: ElwoodTerminal) => terminal.snapshot();
  if (agent !== "claude" && agent !== "codex") throw new Error("Unknown ELWOOD_BENCH_AGENT");
  const responder =
    agent === "claude"
      ? new ClaudeStartupPromptResponder(false)
      : new CodexStartupPromptResponder(benchmarkSessionId, false);
  const observers = {
    agent,
    elwoodSessionId: benchmarkSessionId,
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    table:
      agent === "claude"
        ? claudeScreenFactTableForTrustPolicy(false)
        : codexScreenFactTableForTrustPolicy(false),
    emitActivity: () => undefined,
  } satisfies RenderedObservers;
  observers.turn.arm();
  const replay = new TerminalReplayBuffer(benchmarkSessionId);
  return (data: string, terminal: ElwoodTerminal) => {
    replay.push(data);
    const frame = { text: terminal.snapshot().text, title: terminal.title };
    responder.handle(frame.text, () => {
      throw new Error("Unexpected benchmark dialog");
    });
    observeRenderedFrame(observers, frame, undefined);
  };
}
