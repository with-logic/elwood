/** Human-to-automation attention handoff preserves work and labels (C-ATTN-02/03). */
import { expect, test, vi } from "vitest";
import {
  claudeScreenFactTableForTrustPolicy,
  claudeTrustClearance,
} from "../../src/claude/screen-table.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import { createSessionFrameObserver } from "../../src/runtime/session/frames.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";

import { claudeComposer } from "../fixtures/trust-composer.ts";

const approval = "Do you want to create elwood.txt?\n❯ 1. Yes\n  3. No\nEsc to cancel";
const working = "❯ \n  ⏵⏵ bypass permissions on · esc to interrupt";

function harness(started = true) {
  const ready = vi.fn();
  const activity = vi.fn();
  const engine = new SessionStatusEngine({
    onReady() {},
    emitStatus() {},
    queueRunning() {},
    queueReady: ready,
    queueBlocked() {},
    queueClose() {},
    cleanup() {},
  });
  if (started) engine.submit("initial_ready");
  ready.mockClear();
  const active = {
    closing: new AbortController(),
    inputBlocking: false,
    automationBlocking: false,
    get status() {
      return engine.status;
    },
    submitEvidence: (kind: Parameters<typeof engine.submit>[0], workingVisible = false) =>
      engine.submit(kind, { inputBlocked: active.automationBlocking, workingVisible }),
  };
  const trust = { inputBlocking: false, blockedPrompt: undefined, dispose() {} };
  const turn = new TurnStateWatcher();
  turn.arm(true);
  const observer = createSessionFrameObserver(
    {
      turn,
      attention: new AttentionWatcher(),
      table: claudeScreenFactTableForTrustPolicy(true),
      agent: "claude",
      elwoodSessionId: "handoff",
      emitActivity: activity,
    },
    () => active,
    () => trust,
    createReadinessGate(() => undefined, false),
    claudeTrustClearance,
  );
  const frame = (text: string) => observer.observe({ text, title: "" });
  return { engine, ready, activity, active, trust, observer, frame };
}

test.each([
  false,
  true,
])("C-ATTN-02 automation release preserves work after partial=%s", (partial) => {
  const { engine, ready, trust, frame } = harness();
  frame(approval);
  trust.inputBlocking = true;
  frame(claudeComposer);
  expect(engine.status).toBe("blocked");
  trust.inputBlocking = false;
  if (partial) {
    frame("");
    expect(engine.status).toBe("blocked");
  }
  frame(working);
  expect(engine.status).toBe("running");
  expect(ready).not.toHaveBeenCalled();
  frame(claudeComposer);
  expect(engine.status).toBe("ready");
  expect(ready).toHaveBeenCalledTimes(1);
});

test("C-ATTN-03 startup blank repaint retains the deferred attention label", () => {
  const { engine, activity, active, observer, frame } = harness(false);
  frame(approval);
  frame("");
  expect(activity).not.toHaveBeenCalled();
  engine.submit("startup_usable");
  observer.blockOnceLive(active);
  expect(activity).toHaveBeenCalledWith(
    expect.objectContaining({ label: "claude-permission-dialog" }),
  );
});

test("C-ATTN-02 automation release to verified idle replays the consumed human clearance once", () => {
  const { engine, ready, trust, frame } = harness();
  frame(approval);
  trust.inputBlocking = true;
  frame(claudeComposer);
  expect(engine.status).toBe("blocked");
  trust.inputBlocking = false;
  frame(claudeComposer);
  expect(engine.status).toBe("ready");
  expect(ready).toHaveBeenCalledTimes(1);
  frame(claudeComposer);
  expect(ready).toHaveBeenCalledTimes(1);
});
