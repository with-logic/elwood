/** Provider choice and terminal proof contracts for structured trust answers (C-ATTN-07). */
import type { SelectableOption } from "../../terminal-options.ts";
import type { TrustStep } from "../../trust/step.ts";

export type AnswerFailure =
  | "busy"
  | "aborted"
  | "frame"
  | "terminal_write"
  | "terminal_exit"
  | "native_acceptance";

export type WorkspaceTrustOutcome = "affirmative" | "back" | "exit";
type AnswerRequest<ChoiceIndex> = {
  readonly gateIdentity: string;
  readonly earliestInputAtMs?: number;
  readonly request: { readonly id: string };
  readonly choices: readonly {
    readonly id: string;
    readonly choiceIndex: ChoiceIndex;
    readonly outcome: WorkspaceTrustOutcome;
  }[];
};

type VerifiedChoice<Option> = {
  readonly frame: object;
  readonly option: Option;
  /** Recheck the live frame, request and ownership synchronously just before the key. */
  claim(): boolean;
};
/** Collect fresh proof for a key, finishing once synchronously or asynchronously.
 * An empty completion means no new verified choice. The previous frame token
 * identifies the last attempted key's render, which cannot authorize another. */
export type ReadChoice<Option, ChoiceIndex extends number = number> = (
  gate: string,
  choiceIndex: ChoiceIndex,
  requestId: string,
  previousFrame: object | undefined,
  finish: (choice?: VerifiedChoice<Option>) => void,
  signal: AbortSignal,
) => void;

export type AnswerIo<Option extends SelectableOption, ChoiceIndex extends number> = {
  readonly currentRequest: () => AnswerRequest<ChoiceIndex> | undefined;
  readonly readChoice: ReadChoice<Option, ChoiceIndex>;
  readonly step: (option: Option) => Pick<TrustStep, "keys" | "confirm">;
  readonly write: (keys: string) => Promise<void>;
  /** Recheck native acceptance after a fulfilled confirmation write. */
  readonly reconcileDialogEvidence: () => void;
  readonly relinquish: (gateIdentity: string) => void;
};
