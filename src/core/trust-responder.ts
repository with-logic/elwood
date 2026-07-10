/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 *
 * Policy (Steve's directive): an agent must NEVER be left waiting on a trust gate.
 * Under the caller's full-trust posture, when an allowlisted trust prompt is
 * visible in the current frame, Elwood selects its affirmative option and sends
 * it — always say yes. Elwood only auto-answers ALLOWLISTED prompts (an
 * off-allowlist confirmation is left to the human), and never re-answers the same
 * prompt; those are the only limits.
 */

import type { ElwoodAgentKind } from "./activity.ts";
import { numberedOptions } from "./terminal-options.ts";
import {
  type TrustPromptIdFor,
  trustPromptAllowlist,
  trustPromptHeaderVisible,
} from "./trust-prompts.ts";

/** The concrete allowlist entry type (preserves the derived literal `id`). */
type TrustPromptEntry = (typeof trustPromptAllowlist)[number];

/** An answered trust prompt; `prompt` is narrowed to the responder's agent. */
export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};

/**
 * The outcome of handling a frame: an answered prompt, a recognized prompt whose
 * affirmative option has not rendered yet (a TRANSIENT render delay — under the
 * say-yes policy a later frame carrying the option is still answered, so this is
 * never a terminal wedge), or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | { readonly kind: "answered"; readonly automation: TrustPromptAutomation<A> }
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
  handle(frame: string, write: (input: string) => void): TrustPromptResult<A> {
    const options = numberedOptions(frame);
    for (const spec of this.specs) {
      const id = spec.id as TrustPromptIdFor<A>;
      // `answerPolicy: "always"` prompts (Elwood's own hook bridge) answer
      // regardless of autotrust; every other trust prompt requires the caller's
      // full-trust posture.
      if (!(this.autotrust || spec.answerPolicy === "always")) continue;
      // Recognized when the prompt's HEADER wording appears on a NON-OPTION line
      // (via the shared `trustPromptHeaderVisible`), so a phrase living only inside
      // an option label can't spoof a prompt. That is the ONLY guard — recognition
      // means "say yes".
      if (this.settled.has(id) || !trustPromptHeaderVisible(frame, spec)) continue;
      const option = options.find((o) => spec.accept.test(o.label))?.number;
      if (option === undefined) {
        // Affirmative not rendered yet (partial frame). Report once, but DON'T
        // settle — a later frame with the option can still be answered.
        if (this.reportedPending.has(id)) continue;
        this.reportedPending.add(id);
        return { kind: "option_pending", prompt: id };
      }
      write(`${option}\r`);
      this.settled.add(id);
      return { kind: "answered", automation: { prompt: id, input: option } };
    }
    return undefined;
  }
}

/** True when an allowlisted trust prompt for `agent` is visible in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && trustPromptHeaderVisible(text, spec),
  );
}
