/** Attempt descriptors distinguish trust input from confirmed clearance (PRD §5.4). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { StartupWriteCompletion } from "../startup/write.ts";
import { optionInput, type SelectableOption } from "../terminal-options.ts";
import type { TrustPromptIdFor } from "./prompts.ts";
import type { NumberedRetry, TrustPhase } from "./step.ts";
import { choiceIdentity, type TrustCandidate } from "./view.ts";
import type { TrustAttempt } from "./write.ts";

export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};
/** What an adapter supplies beside its clearance grammar (C-TRUST-01). */
export type TrustHooks = {
  /** Told when blocking state changes without a frame (expiry, settlement). */
  readonly onStateChange?: (() => void) | undefined;
  /** What a numbered retry writes; the default retypes only after a rendered frame. */
  readonly numberedRetry?: NumberedRetry;
};
/** Raw PTY result; the coordinator separately owns cancellation and clearance. */
export type TrustWriteResult = void | Promise<void>;
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | {
      readonly kind: "attempted";
      readonly automation: TrustPromptAutomation<A>;
      readonly settled: Promise<StartupWriteCompletion>;
    }
  | { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

/** Mutable coordinator state stays owned by a single observed trust generation. */
export type Episode = {
  candidate: TrustCandidate;
  blocked: boolean;
  expired: boolean;
  expiredIdentity: string | undefined;
  lastIdentity: string | undefined;
  attemptedIdentity: string | undefined;
  reportedPending: boolean;
  legacyAnswered: boolean;
  /** Raw caller input reached this gate; automation writes nothing more to it. */
  callerOwned: boolean;
  /** Every attempt at this gate shares it, so its writes and frames outlive each attempt. */
  readonly phase: TrustPhase;
  attempt: TrustAttempt | undefined;
};

/** A fresh episode for a newly observed candidate; only `blocked` carries over. */
export function newEpisode(candidate: TrustCandidate, blocked: boolean): Episode {
  return {
    candidate,
    blocked,
    expired: false,
    expiredIdentity: undefined,
    lastIdentity: choiceIdentity(candidate),
    attemptedIdentity: undefined,
    reportedPending: false,
    legacyAnswered: false,
    callerOwned: false,
    phase: { confirmed: false, renderedSinceWrite: false },
    attempt: undefined,
  };
}

/** The result announcing an attempt at `prompt`'s affirmative `option`. */
export function attempted<A extends ElwoodAgentKind>(
  prompt: TrustPromptIdFor<A>,
  option: SelectableOption,
  settled: Promise<StartupWriteCompletion>,
): TrustPromptResult<A> {
  return { kind: "attempted", automation: { prompt, input: optionInput(option) }, settled };
}

/**
 * The gate left the frame. An unconfirmed attempt lost its choice; a confirmed answer
 * keeps waiting for verified clearance or the gate's return, unless an off-allowlist
 * gate a human must answer replaced it (C-TRUST-01).
 */
export function leaveFrame(episode: Episode, offAllowlistGate: boolean): void {
  episode.lastIdentity = undefined;
  if (episode.attempt !== undefined && episode.phase.confirmed && !offAllowlistGate) return;
  episode.attempt?.cancel();
  episode.attempt = undefined;
  episode.attemptedIdentity = undefined;
  // Another complete dialog replaced the gate, so the CLI drew its return afresh.
  if (offAllowlistGate) episode.phase.confirmed = false;
}
