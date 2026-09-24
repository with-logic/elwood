/**
 * Lifecycle warning shapes split out of the main warning union (§6.4, §9.2) to
 * keep `index.ts` under the file-size cap. These are ordinary `ElwoodWarningEvent` members.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";

/**
 * Best-effort `claude update` / `codex update` failed but the INSTALLED CLI still meets the
 * minimum, so the session started from it. Safe diagnostics only: the installed version in use,
 * an allowlisted `errorCode` (a probe timeout/`errno`), and bounded `raw` stderr — never terminal
 * transcripts, prompts, tokens, or environment secrets.
 * Contention uses `errorCode: "update_active"` and a canonical skipped-update message.
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

export type ObserverFailureWarning = HookObserverFailedWarning | InitialReadyObserverFailedWarning;
