/** Attempt descriptors distinguish trust input from confirmed clearance (PRD §5.4). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { StartupWriteCompletion } from "../startup/write.ts";
import type { TrustPromptIdFor } from "./prompts.ts";
import { choiceIdentity, type TrustCandidate } from "./view.ts";
import type { TrustAttempt } from "./write.ts";

export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
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
  deadlineAtMs: number;
  blocked: boolean;
  expired: boolean;
  expiredIdentity: string | undefined;
  lastIdentity: string | undefined;
  attemptedIdentity: string | undefined;
  reportedPending: boolean;
  legacyAnswered: boolean;
  attempt: TrustAttempt | undefined;
};

/** A fresh episode for a newly observed candidate; only `blocked` carries over. */
export function newEpisode(candidate: TrustCandidate, blocked: boolean): Episode {
  return {
    candidate,
    deadlineAtMs: 0,
    blocked,
    expired: false,
    expiredIdentity: undefined,
    lastIdentity: choiceIdentity(candidate),
    attemptedIdentity: undefined,
    reportedPending: false,
    legacyAnswered: false,
    attempt: undefined,
  };
}
