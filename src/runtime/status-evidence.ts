/**
 * Evidence-driven session status engine: every status transition flows from
 * an explicit evidence record so transitions stay idempotent and explainable.
 * Implements PRD §5.3 and §9 lifecycle guarantees.
 */

import { liveStatuses } from "../core/status-categories.ts";
import type {
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  ElwoodStatusEvidence,
} from "../core/types.ts";
import { canTransition } from "./session/status.ts";

/** The evidence kinds the engine accepts; the public alias is the source. */
export type StatusEvidenceKind = ElwoodStatusEvidence;

export type StatusDecision = ElwoodStatusDecision;

const evidenceTargets: Readonly<Record<StatusEvidenceKind, ElwoodSessionStatus>> = {
  startup_usable: "running",
  initial_ready: "ready",
  hook_turn_ended: "ready",
  rendered_turn_started: "running",
  rendered_turn_ended: "ready",
  caller_submitted: "running",
  blocking_prompt_shown: "blocked",
  blocking_prompt_cleared: "ready",
  terminal_exited: "exited",
  stop_completed: "stopped",
  kill_completed: "killed",
  teardown_completed: "torn_down",
};

/**
 * Turn and blocking evidence is only meaningful once the session is live: it
 * describes activity within an interactive session and must not fire from
 * `starting`. Readiness bootstrap (`startup_usable`, `initial_ready`) is
 * excluded — those are the transitions that establish liveness.
 */
const requiresLiveSession = new Set<StatusEvidenceKind>([
  "hook_turn_ended",
  "rendered_turn_started",
  "rendered_turn_ended",
  "caller_submitted",
  "blocking_prompt_shown",
  "blocking_prompt_cleared",
]);

export function decideStatus(
  from: ElwoodSessionStatus,
  evidence: StatusEvidenceKind,
): StatusDecision {
  const target = evidenceTargets[evidence];
  const ignored = (reason: string): StatusDecision => ({ evidence, from, to: undefined, reason });
  // Turn/blocking evidence describes in-session activity; before the session
  // is live (`starting`) it must not fabricate `ready`/`running`/`blocked`.
  if (requiresLiveSession.has(evidence) && !liveStatuses.has(from)) {
    return ignored(`ignored: ${evidence} before the session is live (${from})`);
  }
  // Startup readiness must not regress a session that a hook already advanced:
  // if `initial_ready` reached `ready` first, a late `startup_usable` is stale.
  if (evidence === "startup_usable" && from !== "starting") {
    return ignored(`ignored: startup_usable after the session left starting (${from})`);
  }
  // A blocking dialog only blocks a session that is mid-turn or idle-ready.
  if (evidence === "blocking_prompt_shown" && !(from === "running" || from === "ready")) {
    return ignored(`ignored: cannot block from ${from}`);
  }
  // Initial readiness must not reopen a session that is currently blocked: a
  // startup dialog (e.g. a trust prompt) can be on screen when the readiness
  // hook or its deadline fires, and applying `ready` here would drain queued
  // input into the dialog. Only `blocking_prompt_cleared` may leave `blocked`.
  if (evidence === "initial_ready" && from === "blocked") {
    return ignored("ignored: initial_ready must not reopen a blocked session");
  }
  // A cleared blocking prompt only settles a session that was actually
  // blocked; otherwise the clear is stale (the composer resumed on its own).
  if (evidence === "blocking_prompt_cleared" && from !== "blocked") {
    return ignored(`ignored: ${from} is not blocked`);
  }
  if (!canTransition(from, target)) {
    return ignored(`ignored: ${from} cannot become ${target}`);
  }
  return { evidence, from, to: target, reason: `applied: ${from} became ${target}` };
}

/** Diagnostics stay bounded; the log is live-only and never persisted. */
export const maxStatusDecisions = 50;

export type StatusEngineIo = {
  /** Note that the session reached `ready` at least once (idempotent, live-only). */
  readonly onReady: () => void;
  /** Deliver status/activity events to listeners (a listener throw propagates). */
  readonly emitStatus: (status: ElwoodSessionStatus) => void;
  readonly queueRunning: () => void;
  readonly queueReady: () => void;
  /** Suspend queue readiness without implying a new turn (blocked dialog). */
  readonly queueBlocked: () => void;
  readonly queueClose: () => void;
  readonly cleanup: () => void;
};

export class SessionStatusEngine {
  private readonly io: StatusEngineIo;
  private readonly log: StatusDecision[] = [];
  private current: ElwoodSessionStatus = "starting";

  constructor(io: StatusEngineIo) {
    this.io = io;
  }

  get status(): ElwoodSessionStatus {
    return this.current;
  }

  decisions(): readonly StatusDecision[] {
    return this.log;
  }

  submit(kind: StatusEvidenceKind): StatusDecision {
    const decision = decideStatus(this.current, kind);
    this.log.push(decision);
    if (this.log.length > maxStatusDecisions) this.log.shift();
    if (decision.to !== undefined) this.apply(decision.to);
    return decision;
  }

  private apply(to: ElwoodSessionStatus): void {
    if (to === "running") {
      // Turn start: commit `current` and suspend the queue BEFORE the public emit, so a
      // throwing status LISTENER can never skip the suspend (it runs after). A throwing
      // caller_submitted listener is additionally CONTAINED in ControlQueue.beginSubmission
      // so it cannot abort the pending PTY write.
      this.current = to;
      this.io.queueRunning();
      this.io.emitStatus(to);
      return;
    }
    this.current = to;
    if (to === "ready") {
      // `onReady` (a non-throwing latch) runs before listeners so one checking
      // "has been ready" sees it. The queue reopen is guaranteed in a `finally`: a
      // throwing status listener must NOT skip queueReady(), or the queue stays
      // suspended while `current` is already `ready`, so later ready evidence is a
      // no-op and queued work starves.
      this.io.onReady();
      try {
        this.io.emitStatus(to);
      } finally {
        this.io.queueReady();
      }
      return;
    }
    if (to === "blocked") {
      // A human-decision dialog is on screen: suspend the queue BEFORE the emit so a
      // status listener that synchronously calls back cannot drain a queued send into
      // the dialog. Suspend-first also means a throwing listener can't skip the suspend.
      this.io.queueBlocked();
      this.io.emitStatus(to);
      return;
    }
    this.io.queueClose();
    // On an unsolicited exit, runtime cleanup must run even if emitting the `exited`
    // status throws — otherwise a throwing status listener would leak the
    // bridge/watcher/terminal (PRD §9.4). `cleanup()` is itself failure-isolated (it
    // floats a retryable promise), so it never re-throws here.
    try {
      this.io.emitStatus(to);
    } finally {
      if (to === "exited") this.io.cleanup();
    }
  }
}
