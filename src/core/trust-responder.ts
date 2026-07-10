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
import { type TrustPromptIdFor, trustPromptAllowlist } from "./trust-prompts.ts";

/** The concrete allowlist entry type (preserves the derived literal `id`). */
type TrustPromptEntry = (typeof trustPromptAllowlist)[number];

/** An answered trust prompt; `prompt` is narrowed to the responder's agent. */
export type TrustPromptAutomation<A extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly prompt: TrustPromptIdFor<A>;
  readonly input: string;
};

/**
 * The outcome of handling a frame: an answered prompt, a recognized prompt whose
 * affirmative option is not present in the frame yet (still rendering — retry next
 * frame), or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | { readonly kind: "answered"; readonly automation: TrustPromptAutomation<A> }
  | { readonly kind: "unanswerable"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

export class TrustPromptResponder<A extends ElwoodAgentKind> {
  private readonly enabled: boolean;
  private readonly specs: readonly TrustPromptEntry[];
  private readonly settled = new Set<TrustPromptIdFor<A>>();
  // A prompt whose "no option yet" state was reported once, kept SEPARATE from
  // `settled` so a later frame with the real option can still be answered.
  private readonly reportedUnanswerable = new Set<TrustPromptIdFor<A>>();

  constructor(agent: A, enabled = false) {
    this.enabled = enabled;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(frame: string, write: (input: string) => void): TrustPromptResult<A> {
    const options = numberedOptions(frame);
    for (const spec of this.specs) {
      const id = spec.id as TrustPromptIdFor<A>;
      // `always` prompts (Elwood's own hook bridge) answer regardless of autotrust;
      // every other trust prompt requires the caller's full-trust posture.
      if (!(this.enabled || ("always" in spec && spec.always))) continue;
      // Recognized when the prompt's `visible` HEADER wording appears on a
      // NON-OPTION line, so a phrase living only inside an option label can't spoof
      // a prompt. That is the ONLY guard — recognition means "say yes".
      if (this.settled.has(id) || !isVisible(frame, spec)) continue;
      const option = options.find((o) => spec.accept.test(o.label))?.number;
      if (option === undefined) {
        // Affirmative not rendered yet (partial frame). Report once, but DON'T
        // settle — a later frame with the option can still be answered.
        if (this.reportedUnanswerable.has(id)) continue;
        this.reportedUnanswerable.add(id);
        return { kind: "unanswerable", prompt: id };
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
  return trustPromptAllowlist.some((spec) => spec.agent === agent && isVisible(text, spec));
}

/**
 * True when `spec`'s HEADER is visible: its `visible` phrase matches the frame's
 * NON-OPTION lines (joined, so a wrapped header spanning rows still matches). An
 * option-only phrase — e.g. "1. Yes, trust this plugin" — never matches, so a
 * hostile option cannot masquerade as a trust prompt (PRD §5.1).
 */
function isVisible(frame: string, spec: TrustPromptEntry): boolean {
  const header = frame
    .split("\n")
    .filter((line) => !isOptionLine(line))
    .join(" ");
  return spec.visible.test(header);
}

/** True when `line` is itself a numbered option (e.g. "1. ...", "› 2) ..."). */
function isOptionLine(line: string): boolean {
  return /(?:^|[\s›>])\d+[.)]/.test(line);
}
