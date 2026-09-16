/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 *
 * Policy (PRD §5.1): an agent must NEVER be left waiting on a trust gate.
 * Under the caller's full-trust posture, when an allowlisted trust prompt is
 * visible in the current frame, Elwood selects its affirmative option and sends
 * it. Recognition binds the header and answer to one active dialog and every
 * write revalidates it; unrelated confirmations remain with the human.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { optionInput } from "../terminal-options.ts";
import { trustDialog } from "./dialog.ts";
import {
  type TrustPromptIdFor,
  trustPromptAllowlist,
  trustPromptHeaderVisible,
} from "./prompts.ts";
import { writeTrustOption } from "./write.ts";

/** The concrete allowlist entry type (preserves the derived literal `id`). */
type TrustPromptEntry = (typeof trustPromptAllowlist)[number];

/** An answered trust prompt; `prompt` is narrowed to the responder's agent. */
export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};

/**
 * The completion of an answered trust write: a `void | Promise<void>` write is
 * normalized to a promise that resolves on success and rejects once the prompt
 * has been un-settled (kept retryable) on a rejected write.
 */
export type TrustWriteResult = void | Promise<void>;

/**
 * The outcome of handling a frame: an answered prompt, a recognized prompt whose
 * affirmative option has not rendered yet (a TRANSIENT render delay — under the
 * say-yes policy a later frame carrying the option is still answered, so this is
 * never a terminal wedge), or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | {
      readonly kind: "answered";
      readonly automation: TrustPromptAutomation<A>;
      // Resolves when the affirmative write fulfills; rejects (after the prompt is
      // un-settled, so a later frame re-attempts it) if the write is rejected.
      readonly settled: Promise<void>;
    }
  | { readonly kind: "option_pending"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

export class TrustPromptResponder<A extends ElwoodAgentKind> {
  // Whether the caller launched under full trust (`autotrust`). `answerPolicy:
  // "always"` prompts (hook trust) are answered even when this is false.
  private readonly autotrust: boolean;
  private readonly specs: readonly TrustPromptEntry[];
  private readonly settled = new Set<TrustPromptIdFor<A>>();
  // A prompt whose "option not rendered yet" state was reported once, kept
  // SEPARATE from `settled` so a later frame with the real option can still be
  // answered — the pending state is transient, not terminal.
  private readonly reportedPending = new Set<TrustPromptIdFor<A>>();

  constructor(agent: A, autotrust = false) {
    this.autotrust = autotrust;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(
    frame: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
  ): TrustPromptResult<A> {
    for (const spec of this.specs) {
      const id = spec.id as TrustPromptIdFor<A>;
      // Codex hook trust covers all configured hooks regardless of autotrust.
      if (!(this.autotrust || spec.answerPolicy === "always") || this.settled.has(id)) continue;
      const dialog = trustDialog(frame, spec.headerPattern);
      if (dialog === undefined) continue;
      const options = dialog.options;
      const option = options.find((candidate) => spec.accept.test(candidate.label));
      if (option === undefined) {
        // Affirmative not rendered yet (partial frame). Report once, but DON'T
        // settle — a later frame with the option can still be answered.
        if (this.reportedPending.has(id)) continue;
        this.reportedPending.add(id);
        return { kind: "option_pending", prompt: id };
      }
      // Settle OPTIMISTICALLY so a second frame in the same tick does not re-answer,
      // but keep the settle contingent on the write: if the write is rejected we
      // un-settle here so a later frame re-attempts it, and the returned `settled`
      // promise rejects so the caller emits a warning instead of a false "answered".
      this.settled.add(id);
      const input = optionInput(option);
      const operation = writeTrustOption(spec, option, write, frame, readFrame);
      const settled = operation.catch((error: unknown) => {
        this.settled.delete(id);
        throw error;
      });
      return { kind: "answered", automation: { prompt: id, input }, settled };
    }
    return undefined;
  }
}

/** Whether any allowlisted trust prompt for `agent` is showing its header in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && trustPromptHeaderVisible(text, spec),
  );
}
