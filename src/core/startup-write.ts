/**
 * Completion-aware settlement for automated startup-prompt PTY writes.
 * Implements PRD §5.1, §5.4, and §5.7: a startup prompt is marked answered (its
 * `startup_prompt` activity emitted) ONLY after its `sendInput` write actually
 * fulfills. A rejected write leaves the prompt retryable and surfaces a bounded,
 * content-free `startup_prompt_write_failed` warning instead of false telemetry
 * (C-CLAUDE-16, C-CODEX-17).
 */

import type { ElwoodAgentKind } from "./activity.ts";
import type { StartupPromptLabel } from "./startup-automation.ts";
import {
  emitStartupPromptActivity,
  type StartupActivityEmitter,
  type StartupPromptOutcome,
} from "./startup-automation.ts";
import type { ElwoodWarningEvent } from "./warnings.ts";

/** A settled startup-prompt automation: an outcome plus its write completion. */
export type SettledStartupOutcome<A extends ElwoodAgentKind> = {
  readonly outcome: StartupPromptOutcome<A>;
  // Present only for a write-backed `answered` outcome: resolves on write
  // success and rejects (after the responder has un-settled the prompt) on a
  // rejected write. Absent for `option_pending` (no write happened).
  readonly settled?: Promise<void>;
};

/** Where a rejected startup-prompt write is reported. */
export type StartupWarningSink = {
  recordWarnings(warnings: readonly ElwoodWarningEvent[]): void;
};

/**
 * Emit each settled automation's activity at the RIGHT time: an `option_pending`
 * or write-less outcome emits immediately; a write-backed `answered` outcome emits
 * its `startup_prompt` activity only once the write resolves, and on rejection
 * emits a bounded warning instead — never a false "answered" activity.
 */
export function emitSettledStartupOutcomes<A extends "claude" | "codex">(
  emitter: StartupActivityEmitter,
  agent: A,
  elwoodSessionId: string,
  settledOutcomes: readonly SettledStartupOutcome<A>[],
  warnings: StartupWarningSink | undefined,
): void {
  for (const { outcome, settled } of settledOutcomes) {
    if (settled === undefined) {
      emitStartupPromptActivity(emitter, agent, elwoodSessionId, outcome);
      continue;
    }
    settled.then(
      () => emitStartupPromptActivity(emitter, agent, elwoodSessionId, outcome),
      () => warnings?.recordWarnings([writeFailedWarning(agent, elwoodSessionId, outcome)]),
    );
  }
}

function writeFailedWarning<A extends "claude" | "codex">(
  agent: A,
  elwoodSessionId: string,
  outcome: StartupPromptOutcome<A>,
): ElwoodWarningEvent {
  const label = outcome.prompt as StartupPromptLabel;
  return {
    elwoodSessionId,
    agent,
    source: "terminal",
    code: "startup_prompt_write_failed",
    severity: "warning",
    message: `Startup prompt ${label} could not be answered: PTY write was rejected; leaving it retryable.`,
    label,
    raw: `startup_prompt_write_failed label=${label}`,
  };
}
