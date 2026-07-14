/**
 * Completion-aware settlement for automated startup-prompt PTY writes.
 * Implements PRD §5.1, §5.4, and §5.7: a startup prompt is marked answered (its
 * `startup_prompt` activity emitted) ONLY after its `sendInput` write actually
 * fulfills. A rejected write leaves the prompt retryable and surfaces a bounded,
 * content-free `startup_prompt_write_failed` warning instead of false telemetry
 * (C-CLAUDE-16, C-CODEX-17).
 */

import type { ElwoodAgentKind } from "./activity.ts";
import type { StartupPromptLabel, TrustPromptIdFor } from "./startup-automation.ts";
import {
  emitStartupPromptActivity,
  type StartupActivityEmitter,
  type StartupPromptLabelFor,
  type StartupPromptOutcome,
} from "./startup-automation.ts";
import type { ElwoodWarningEvent } from "./warnings.ts";

/**
 * A settled startup-prompt automation, discriminated by `outcome.kind` so the
 * invalid pairings are unrepresentable: an `answered` outcome ALWAYS carries the
 * write-completion `settled` promise (resolves on write success, rejects — after
 * the responder un-settles the prompt — on a rejected write), and an
 * `option_pending` outcome (no write happened) NEVER carries one. This makes a
 * false success ("answered" with no write to await) and a silently lost warning
 * (write present on a non-answered outcome) impossible to construct (§5.4, §5.7).
 */
export type SettledStartupOutcome<A extends ElwoodAgentKind> =
  | {
      readonly outcome: {
        readonly kind: "answered";
        readonly prompt: StartupPromptLabelFor<A>;
        readonly input: string;
      };
      readonly settled: Promise<void>;
    }
  | {
      readonly outcome: { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> };
      readonly settled?: undefined;
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
  for (const settledOutcome of settledOutcomes) {
    if (settledOutcome.settled === undefined) {
      // An `option_pending` outcome: no write happened, so there is nothing to
      // await — emit its attention activity immediately. The discriminated union
      // guarantees this branch is only ever `option_pending`.
      emitStartupPromptActivity(emitter, agent, elwoodSessionId, settledOutcome.outcome);
      continue;
    }
    // An `answered` outcome always carries the write-completion promise: its
    // activity is emitted only once the write fulfills, and a rejected write
    // surfaces a bounded warning instead of a false "answered" activity.
    const { outcome, settled } = settledOutcome;
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
