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
import { canTransition } from "./session-status.ts";

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
  /** Persist and emit an applied status change. */
  readonly onStatus: (status: ElwoodSessionStatus) => void;
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
    this.current = to;
    if (to === "running") {
      this.io.queueRunning();
      this.io.onStatus(to);
      return;
    }
    if (to === "ready") {
      // Status lands before the queue drains so drained sends observe "ready".
      this.io.onStatus(to);
      this.io.queueReady();
      return;
    }
    if (to === "blocked") {
      // A human-decision dialog is on screen: suspend the queue so a queued
      // send cannot write into the dialog. `blocking_prompt_cleared -> ready`
      // is the only path that reopens it.
      this.io.queueBlocked();
      this.io.onStatus(to);
      return;
    }
    this.io.queueClose();
    this.io.onStatus(to);
    if (to === "exited") this.io.cleanup();
  }
}
