/**
 * Lifecycle warning shapes split out of the main warning union (§5.7, §6.4, §9.2) to
 * keep `index.ts` under the file-size cap. These are ordinary `ElwoodWarningEvent` members.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";

/**
 * Best-effort `claude update` / `codex update` failed but the INSTALLED CLI still meets the
 * minimum, so the session started from it. Safe diagnostics only: the installed version in use,
 * an allowlisted `errorCode` (a probe timeout/`errno`), and bounded `raw` updater stderr — never
 * terminal transcripts, prompts, tokens, or environment secrets.
 * Contention uses `errorCode: "update_active"` and a canonical skipped-update message. A login
 * shell that failed before the update ran uses `errorCode: "login_shell_failed"` with empty `raw`.
 */
export type AgentUpdateFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "lifecycle";
  readonly code: "agent_update_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly installedVersion: string;
  readonly errorCode: string;
  readonly raw: string;
  /** The update command's exit status, 128+n if a signal killed it; absent when it reported none. */
  readonly exitStatus?: number;
};

/** A failed optional Codex locator publication (§8.2, C-STATE-15). */
export type CodexRolloutLocatorWriteFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "codex_rollout_locator_write_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly raw: "codex_rollout_locator_write_failed";
};

/** An existing locator or named rollout could not be verified on resume (§8.2). */
export type CodexRolloutLocatorUnavailableWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "codex_rollout_locator_unavailable";
  readonly severity: "warning";
  readonly message: "Elwood could not verify the saved Codex transcript location.";
  readonly raw: "codex_rollout_locator_unavailable";
};

/** One bounded diagnostic for contained notification failures in either hook adapter (C-HOOK-22). */
export type HookObserverFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "lifecycle";
  readonly code: "hook_observer_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly phase: "hook" | "activity" | "hook_error" | "transcript" | "lifecycle";
  readonly raw: string;
};

/** One content-free diagnostic for a Codex readiness observer outside a hook (C-API-42). */
export type InitialReadyObserverFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "initial_ready_observer_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly phase: "lifecycle";
  readonly raw: string;
};

/**
 * The initial-readiness backstop elapsed without a configured composer.
 * Readiness and queued input remain held until positive readiness evidence.
 * Content-free (§5.3, C-API-28).
 */
export type InitialReadyBackstopWarning = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "lifecycle";
  readonly code: "initial_ready_backstop";
  readonly severity: "warning";
  readonly message: string;
  readonly raw: string;
};

/**
 * Codex's footer did not show the effort the session requested by the initial-readiness
 * backstop, so readiness was released on its status footer alone. Content-free (§5.3, C-API-28).
 */
export type CodexEffortUnconfirmedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "codex_effort_unconfirmed";
  readonly severity: "warning";
  readonly message: string;
  readonly raw: "codex_effort_unconfirmed";
};

/** The warnings the initial-readiness gate emits. */
export type InitialReadinessWarning = InitialReadyBackstopWarning | CodexEffortUnconfirmedWarning;

/** One content-free diagnostic for a failed rendered-frame notification (§5.4, C-API-72). */
export type FrameObserverFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "lifecycle";
  readonly code: "frame_observer_failed";
  readonly severity: "warning";
  readonly message: "A rendered-frame notification failed.";
  readonly raw: "frame_observer_failed";
};

export type ObserverFailureWarning = HookObserverFailedWarning | InitialReadyObserverFailedWarning;

/**
 * Content-free: `stop`/`teardown` saw no record of the turn its `Stop` hook ended within
 * the full bound and is about to shut Codex down, so that turn may be lost (§5.7,
 * C-LIFE-13).
 */
export type TurnCommitWaitExpiredWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "lifecycle";
  readonly code: "turn_commit_wait_expired";
  readonly severity: "warning";
  readonly message: string;
  readonly raw: string;
};

/**
 * Content-free: a Claude `Stop` held for queued guidance reached its hang limit with neither the
 * queued turn's `Stop` nor an idle composer, so Elwood released it. That marks the session ready
 * unless a prompt has blocked it (§6.5, C-HOOK-24).
 */
export type ClaudeQueuedTurnUnconfirmedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude";
  readonly source: "lifecycle";
  readonly code: "queued_turn_unconfirmed";
  readonly severity: "warning";
  readonly message: "Claude did not finish the guidance queued at its Stop within the limit, so Elwood released that Stop.";
  readonly raw: "queued_turn_unconfirmed";
};
