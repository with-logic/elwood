/** How a Claude `Stop` ends its turn around a queued turn (PRD §6.5, C-HOOK-24, C-HOOK-22). */
import { afterEach, expect, test, vi } from "vitest";
import {
  endTurnUnlessQueued,
  queuedTurnStartLimitMs,
} from "../../src/claude/session/queued-turn.ts";
import { textDigest } from "../../src/claude/transcript/prompt-keys.ts";
import { ClaudeQueuedPrompts } from "../../src/claude/transcript/queued-prompts.ts";
import { hookObservationBoundary } from "../../src/core/hook-observation.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import type {
  ClaudeEventMap,
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  ElwoodWarningEvent,
} from "../../src/index.ts";
import type { StatusEvidenceKind } from "../../src/runtime/status-evidence.ts";

afterEach(() => void vi.useRealTimers());

type StopOptions = {
  readonly queued?: boolean;
  readonly status?: ElwoodSessionStatus;
  readonly failReady?: boolean;
  readonly failEarly?: boolean;
};

const decision = (to: ElwoodSessionStatus | undefined): ElwoodStatusDecision => ({
  evidence: "rendered_turn_started",
  from: "running",
  to,
  reason: "test",
});

function stop(options: StopOptions = {}) {
  vi.useFakeTimers();
  const queued = new ClaudeQueuedPrompts();
  if (options.queued ?? true) queued.queued(textDigest("note"));
  const evidence: StatusEvidenceKind[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  const emitter = new TypedEmitter<ClaudeEventMap>();
  emitter.on("warning", (warning) => void warnings.push(warning));
  const observation = hookObservationBoundary(emitter, "session", "claude");
  if (options.failEarly)
    observation.run("transcript", () => {
      throw new Error("private scan failure");
    });
  observation.report(); // the Stop's dispatch has finished before any poll runs
  let submissionUnchanged = true;
  let decisions: ElwoodStatusDecision[] = [decision("running")];
  const session = {
    elwoodSessionId: "session",
    status: options.status ?? "running",
    closing: new AbortController(),
    statusDecisions: () => decisions,
    emitWarnings: (next: readonly ElwoodWarningEvent[]) => void warnings.push(...next),
    submitEvidence(kind: StatusEvidenceKind) {
      if (options.failReady) throw new Error("private listener failure");
      evidence.push(kind);
      return { evidence: kind, from: this.status, to: "ready" as const, reason: "applied" };
    },
  };
  endTurnUnlessQueued({
    session,
    transcriptWatcher: { scan: () => {}, queuedPrompts: () => queued },
    observation,
    submissionGenerationUnchanged: () => submissionUnchanged,
  });
  const supersede = () => {
    submissionUnchanged = false;
  };
  const record = (...next: ElwoodStatusDecision[]) => void decisions.push(...next);
  const evict = () => {
    decisions = [decision(undefined)];
  };
  const pastBound = () => vi.advanceTimersByTimeAsync(queuedTurnStartLimitMs + 100);
  return { evidence, warnings, session, supersede, record, evict, pastBound };
}

test("C-HOOK-24 a Stop without queued messages ends the turn at once", () => {
  const { evidence, warnings } = stop({ queued: false });
  expect(evidence).toEqual(["hook_turn_ended"]);
  expect(warnings).toEqual([]);
});

test("C-HOOK-24 an unconfirmed queued turn warns, then ends the turn at the bound", async () => {
  const { evidence, warnings, record, pastBound } = stop();
  record(decision(undefined)); // an ignored decision changes nothing
  expect(evidence).toEqual([]);
  await pastBound();
  expect(evidence).toEqual(["hook_turn_ended"]);
  expect(warnings).toEqual([
    expect.objectContaining({
      agent: "claude",
      code: "queued_turn_unconfirmed",
      raw: "queued_turn_unconfirmed",
    }),
  ]);
});

test("C-HOOK-11 C-HOOK-24 the bound ends no turn that already ended, changed, or was superseded", async () => {
  const ended = stop({ status: "ready" });
  await ended.pastBound();
  expect(ended.evidence).toEqual([]);
  // The screen ended the Stop's turn and raw input started another: that one is not this Stop's.
  const restarted = stop();
  restarted.record(decision("ready"), decision("running"));
  await restarted.pastBound();
  expect([...restarted.evidence, ...restarted.warnings]).toEqual([]);
  // Too many decisions to tell: the Stop-time entry is gone, so rendered evidence decides.
  const evicted = stop();
  evicted.evict();
  await evicted.pastBound();
  expect([...evicted.evidence, ...evicted.warnings]).toEqual([]);
  const superseded = stop();
  superseded.supersede();
  await superseded.pastBound();
  expect([...superseded.evidence, ...superseded.warnings]).toEqual([]);
});

test("C-HOOK-22 C-HOOK-24 a failing readiness listener at the bound is contained in the Stop's one warning", async () => {
  const late = stop({ failReady: true });
  await late.pastBound();
  expect(late.warnings).toEqual([
    expect.objectContaining({ code: "queued_turn_unconfirmed" }),
    expect.objectContaining({ code: "hook_observer_failed", phase: "lifecycle" }),
  ]);
  const both = stop({ failReady: true, failEarly: true });
  await both.pastBound();
  expect(both.warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "transcript" }),
    expect.objectContaining({ code: "queued_turn_unconfirmed" }),
  ]);
  expect(JSON.stringify([...late.warnings, ...both.warnings])).not.toContain("private");
});
