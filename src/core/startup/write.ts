/**
 * Completion-aware settlement for automated startup-prompt PTY writes.
 * Implements PRD §5.1, §5.4, and §5.7: a startup prompt is marked answered (its
 * `startup_prompt` activity emitted) ONLY after its `sendInput` write actually
 * fulfills. A rejected write leaves the prompt retryable and surfaces a bounded,
 * content-free `startup_prompt_write_failed` warning instead of false telemetry
 * (C-CLAUDE-16, C-CODEX-17). Safe cancellation during live trust revalidation
 * emits neither success activity nor a write-failure warning (C-TRUST-01).
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import type { ElwoodWarningEvent, StartupPromptWriteFailed } from "../warnings/index.ts";
import type { TrustPromptIdFor } from "./automation.ts";
import {
  emitStartupPromptActivity,
  type StartupActivityEmitter,
  type StartupPromptLabelFor,
} from "./automation.ts";

/** A disappeared/changed dialog cancels safely without claiming a failed PTY write. */
export type StartupWriteCompletion = "answered" | "cancelled";

/**
 * A settled startup-prompt automation, discriminated by `outcome.kind` so the
 * invalid pairings are unrepresentable: an `attempted` outcome ALWAYS carries the
 * write-completion `settled` promise (resolves on success or safe cancellation,
 * rejects on a failed write), and an `option_pending` outcome (no write happened)
 * NEVER carries one. An attempt without completion and a silently lost warning
 * (write present on a pending outcome) are impossible to construct (§5.4, §5.7).
 */
export type SettledStartupOutcome<A extends ElwoodAgentKind> =
  | {
      readonly outcome: {
        readonly kind: "attempted";
        readonly prompt: StartupPromptLabelFor<A>;
        readonly input: string;
      };
      // biome-ignore lint/suspicious/noConfusingVoidType: existing PTY callbacks resolve Promise<void>; trust navigation additionally reports cancellation.
      readonly settled: Promise<void | StartupWriteCompletion>;
    }
  | {
      readonly outcome: { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> };
      readonly settled?: undefined;
    };

/** Where a rejected startup-prompt write is reported. */
export type StartupWarningSink = {
  emitWarnings(warnings: readonly ElwoodWarningEvent[]): void;
};

/**
 * Emit each settled automation's activity at the RIGHT time: an `option_pending`
 * or write-less outcome emits immediately; an `attempted` outcome emits
 * its `startup_prompt` activity only once the write resolves, and on rejection
 * emits a bounded warning instead. A safely cancelled attempt emits neither.
 */
export function emitSettledStartupOutcomes<A extends ElwoodAgentKind>(
  emitter: StartupActivityEmitter,
  agent: A,
  elwoodSessionId: string,
  // `NoInfer` blocks inference of `A` from the outcomes, so `A` is pinned by the
  // `agent` argument alone. Passing Codex outcomes with `agent: "claude"` no
  // longer widens `A` to the union and cannot construct a cross-agent warning.
  settledOutcomes: readonly SettledStartupOutcome<NoInfer<A>>[],
  warnings: StartupWarningSink | undefined,
): void {
  for (const settledOutcome of settledOutcomes) {
    if (settledOutcome.settled === undefined) {
      // An `option_pending` outcome: no write happened, so there is nothing to
      // await — emit its attention activity immediately. The discriminated union
      // guarantees this branch is only ever `option_pending`. CONTAIN a throwing
      // activity listener exactly as the promise-backed branch does: this runs on the
      // hot startup frame, so an escaping throw would skip the rest of the frame
      // (readiness/blocking observation, `terminal:data`) and could let an already-armed
      // readiness deadline drain queued input into an unlatched dialog (C-API-28).
      try {
        emitStartupPromptActivity(emitter, agent, elwoodSessionId, settledOutcome.outcome);
      } catch {
        // Telemetry must not wedge the frame; the activity is dropped (live-only).
      }
      continue;
    }
    // An `attempted` outcome always carries the write-completion promise: its
    // activity is emitted only once the write fulfills, and a rejected write
    // surfaces a bounded warning instead of a false "answered" activity.
    const { outcome, settled } = settledOutcome;
    // A terminal `.catch` OWNS the derived promise: both continuations call public
    // event paths that can throw (activity emission rethrows listener failures;
    // warning recording can fail), and a floated rejection would be an unhandled
    // rejection that can terminate the host during startup. Swallow it here.
    settled
      .then(
        (completion) => {
          if (completion !== "cancelled")
            emitStartupPromptActivity(emitter, agent, elwoodSessionId, {
              ...outcome,
              kind: "answered",
            });
        },
        () => warnings?.emitWarnings([writeFailedWarning(agent, elwoodSessionId, outcome)]),
      )
      .catch(() => undefined);
  }
}

// `agent` and `outcome` are always the SAME concrete `A` here — the caller
// (`emitSettledStartupOutcomes`) already pins `A` via NoInfer, so this internal
// helper needs no extra guard and its correlation is enforced by construction.
function writeFailedWarning<A extends ElwoodAgentKind>(
  agent: A,
  elwoodSessionId: string,
  outcome: { readonly prompt: StartupPromptLabelFor<A> },
): ElwoodWarningEvent {
  // `outcome.prompt` is already the agent-correlated label, so no cast discards
  // the correlation: an off-agent (label, agent) pairing cannot be constructed.
  const label = outcome.prompt;
  const warning: StartupPromptWriteFailed<A> = {
    elwoodSessionId,
    agent,
    source: "terminal",
    code: "startup_prompt_write_failed",
    severity: "warning",
    message: `Startup prompt ${label} could not be answered: PTY write was rejected; leaving it retryable.`,
    label,
    raw: `startup_prompt_write_failed label=${label}`,
  };
  // A concrete `StartupPromptWriteFailed<"claude"|"codex">` IS an ElwoodWarningEvent
  // member; the widening bridges TS's generic-union assignability gap only (the
  // agent/label correlation above is already enforced at construction).
  return warning as ElwoodWarningEvent;
}
