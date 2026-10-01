/** Cached frame refreshes cannot establish work for newer physical input (C-TURN-04). */
import { expect, test } from "vitest";
import { claudeScreenFactTable, claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { codexScreenFactTable, codexTrustClearance } from "../../src/codex/screen-table.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import { createSessionFrameObserver } from "../../src/runtime/session/frames.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { StopCompletion } from "../../src/runtime/session/stop-completion.ts";
import { bindTurnSubmission } from "../../src/runtime/session/turn-submission.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

for (const agent of ["claude", "codex"] as const) {
  test(`C-TURN-04 ${agent} cached Working refresh cannot authorize a fresh idle completion`, async () => {
    const terminal = createHeadlessTerminal({ cols: 100, rows: 10 }, () => {});
    const engine = new SessionStatusEngine({
      onReady() {},
      emitStatus() {},
      queueRunning() {},
      queueReady() {},
      queueBlocked() {},
      queueClose() {},
      cleanup() {},
    });
    engine.submit("initial_ready");
    const active = {
      terminal,
      closing: new AbortController(),
      inputBlocking: false,
      trustInputBlocking: false,
      get status() {
        return engine.status;
      },
      submitEvidence: (kind: Parameters<typeof engine.submit>[0]) => engine.submit(kind),
    };
    const observers = {
      turn: new TurnStateWatcher(),
      attention: new AttentionWatcher(),
      table: agent === "claude" ? claudeScreenFactTable : codexScreenFactTable,
      agent,
      elwoodSessionId: "test",
      emitActivity() {},
    };
    observers.turn.arm();
    const session = bindTurnSubmission(
      { ...active, stopCompletion: new StopCompletion(active) },
      observers,
    );
    const readiness = createReadinessGate(() => {}, false);
    readiness.ready.mark();
    const frames = createSessionFrameObserver(
      observers,
      () => active,
      () => ({ inputBlocking: false, blockedPrompt: undefined, dispose() {} }),
      readiness,
      agent === "claude" ? claudeTrustClearance : codexTrustClearance,
    );
    const working =
      agent === "claude"
        ? "❯ \n ⏵⏵ bypass permissions · esc to interrupt · ← for agents"
        : "• Working (3s • esc to interrupt)\n› ";
    const idle = agent === "claude" ? "❯ \n ⏵⏵ bypass permissions" : "› \n gpt-5.6 low";
    const paint = async (text: string) => {
      await terminal.writeOutput(`\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}`);
      frames.observe({ text: terminal.snapshot().text, title: terminal.title });
    };
    try {
      await paint(working);
      expect(active.status).toBe("running");
      session.stopCompletion.prepareRenderedReset();
      await terminal.sendInput("\r");
      session.stopCompletion.submitted();
      // Trust/deadline refreshes reclassify the retained frame without receiving bytes.
      frames.refresh();
      await paint(idle);
      expect(active.status).toBe("running");
      await paint(working);
      await paint(idle);
      expect(active.status).toBe("ready");
    } finally {
      readiness.ready.cancel();
      terminal.dispose();
    }
  });
}
