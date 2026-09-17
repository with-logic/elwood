/** Trust fallback uses the ordinary attention/readiness owner (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import {
  bindStartupLifetime,
  createSessionFrameObserver,
} from "../../src/runtime/session/frames.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";

afterEach(() => vi.useRealTimers());

test("C-TRUST-01 a timer block is observable without a frame, with guards latched first", () => {
  vi.useFakeTimers();
  const engine = new SessionStatusEngine({
    onReady() {},
    emitStatus() {},
    queueRunning() {},
    queueReady() {},
    queueBlocked() {},
    queueClose() {},
    cleanup() {},
  });
  engine.submit("startup_usable");
  const active = {
    closing: new AbortController(),
    inputBlocking: false,
    automationBlocking: false,
    get status() {
      return engine.status;
    },
    submitEvidence: engine.submit.bind(engine),
  };
  let attached = false;
  const trust = {
    inputBlocking: true,
    blockedPrompt: undefined as string | undefined,
    dispose: vi.fn(),
  };
  const activity = vi.fn(() => {
    expect(active.inputBlocking).toBe(true);
    expect(active.automationBlocking).toBe(true);
  });
  const readiness = createReadinessGate(vi.fn(), false);
  const observe = createSessionFrameObserver(
    {
      turn: new TurnStateWatcher(),
      attention: new AttentionWatcher(),
      table: claudeScreenFactTableForTrustPolicy(true),
      agent: "claude",
      elwoodSessionId: "test",
      emitActivity: activity,
    },
    () => (attached ? active : undefined),
    () => trust,
    readiness,
  );
  observe.refresh();
  attached = true;
  observe.refresh();
  expect(vi.getTimerCount()).toBe(0);
  observe.observe({ text: "Do you trust this folder?", title: "" });
  expect(active.automationBlocking).toBe(true);
  expect(engine.status).toBe("running");
  trust.blockedPrompt = "workspace_trust";
  observe.refresh();
  expect(engine.status).toBe("blocked");
  expect(activity).toHaveBeenCalledWith(
    expect.objectContaining({ label: "claude-workspace_trust-prompt" }),
  );
  bindStartupLifetime(active, trust, readiness.ready);
  active.closing.abort();
  active.closing.abort();
  observe.refresh();
  expect(trust.dispose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
