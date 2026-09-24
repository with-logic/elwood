/** Update settlement captures the native edge before queued input repaints (C-CODEX-12/17). */
import { afterEach, expect, test, vi } from "vitest";
import { codexComposerClearance } from "../../src/codex/screen/clearance.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import type { AutomationWriteResult } from "../../src/core/startup/barrier.ts";
import type { TrustWriteResult } from "../../src/core/trust/responder.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import { createSessionFrameObserver } from "../../src/runtime/session/frames.ts";
import { createReadinessGate } from "../../src/runtime/session/readiness.ts";
import { SessionStatusEngine } from "../../src/runtime/status-evidence.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

const update = "Update available! 0.153.3 -> 0.153.4\n1. Update now\n2. Skip";
afterEach(() => vi.useRealTimers());

function fixture(write: () => TrustWriteResult | Promise<AutomationWriteResult>) {
  vi.useFakeTimers();
  let frame = update;
  const engine = new SessionStatusEngine({
    onReady() {},
    emitStatus() {},
    queueRunning() {},
    queueReady() {},
    queueBlocked() {},
    queueClose() {},
    cleanup() {},
  });
  const active = {
    closing: new AbortController(),
    inputBlocking: false,
    trustInputBlocking: false,
    get status() {
      return engine.status;
    },
    submitEvidence: (kind: Parameters<typeof engine.submit>[0], workingVisible = false) =>
      engine.submit(kind, { workingVisible }),
  };
  const responder = new CodexStartupPromptResponder(
    "edge",
    false,
    undefined,
    codexComposerClearance,
    () => active.inputBlocking || active.trustInputBlocking,
  );
  const queuedInput = vi.fn(() => {
    frame = "› queued persona input";
  });
  const readiness = createReadinessGate(queuedInput, true);
  const observer = createSessionFrameObserver(
    {
      turn: new TurnStateWatcher(),
      attention: new AttentionWatcher(),
      table: codexScreenFactTableForTrustPolicy(false),
      agent: "codex",
      elwoodSessionId: "edge",
      emitActivity() {},
    },
    () => active,
    () => responder,
    readiness,
    codexComposerClearance,
  );
  const observe = (text = frame) => {
    frame = text;
    const result = responder.handle(
      frame,
      () => undefined,
      () => frame,
      write,
    );
    observer.observe({ text: frame, title: "" });
    return result;
  };
  return {
    responder,
    observe,
    queuedInput,
    read: () => frame,
    dispose() {
      responder.dispose();
      readiness.ready.cancel();
    },
  };
}

test("C-CODEX-17 the observer settles a written skip before released input hides clearance", async () => {
  const write = vi.fn();
  const f = fixture(write);
  try {
    const result = f.observe();
    await Promise.resolve();
    f.observe(codexSmallComposer);
    expect(f.queuedInput).toHaveBeenCalledOnce();
    expect(codexComposerClearance(f.read())).toBe(false);
    let completion: unknown;
    void result.outcomes[0]?.settled?.then((value) => {
      completion = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completion).toBe("answered");
    await vi.runAllTimersAsync();
    expect(write).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

test.each([
  "fulfilled",
  "withheld",
  "rejected",
  "disposed",
  "replaced",
] as const)("C-CODEX-17 a clearance edge waits for its own %s physical write", async (mode) => {
  const pending = Promise.withResolvers<AutomationWriteResult>();
  const write = vi.fn(() => pending.promise);
  const f = fixture(write);
  try {
    const result = f.observe();
    let completion: unknown;
    void result.outcomes[0]?.settled?.then((value) => {
      completion = value;
    });
    f.observe(codexSmallComposer);
    if (mode === "fulfilled") f.observe(codexSmallComposer);
    await vi.advanceTimersByTimeAsync(0);
    expect(completion).toBeUndefined();
    if (mode === "disposed") f.responder.dispose();
    if (mode === "replaced") f.observe(update);
    if (mode === "rejected") pending.reject(new Error("write rejected"));
    else pending.resolve(mode === "withheld" ? "withheld" : "written");
    await vi.runAllTimersAsync();
    expect(completion).toBe(mode === "fulfilled" ? "answered" : "cancelled");
  } finally {
    f.dispose();
  }
});

test("C-CODEX-12 a completed clearance edge owns settlement despite a late withheld retry", async () => {
  const retry = Promise.withResolvers<AutomationWriteResult>();
  const next = Promise.withResolvers<AutomationWriteResult>();
  const write = vi
    .fn<() => Promise<AutomationWriteResult>>()
    .mockResolvedValueOnce("written")
    .mockImplementationOnce(() => retry.promise)
    .mockImplementation(() => next.promise);
  const f = fixture(write);
  try {
    const first = f.observe();
    await vi.advanceTimersByTimeAsync(250);
    expect(write).toHaveBeenCalledTimes(2);
    f.observe(codexSmallComposer);
    await expect(first.outcomes[0]?.settled).resolves.toBe("answered");
    const later = f.observe(update);
    expect(write).toHaveBeenCalledTimes(3);
    retry.resolve("withheld");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.observe(update).outcomes).toEqual([]);
    next.resolve("withheld");
    await expect(later.outcomes[0]?.settled).resolves.toBe("cancelled");
  } finally {
    f.dispose();
  }
});
