/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 */

import type { ElwoodAgentKind } from "./activity.ts";
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
 * verified affirmative option is absent (so it cannot be safely auto-answered),
 * or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | { readonly kind: "answered"; readonly automation: TrustPromptAutomation<A> }
  | { readonly kind: "unanswerable"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

/**
 * Answers each allowlisted trust prompt for one agent at most once, and only
 * when enabled (the caller's full-trust/autotrust posture). Generic in the agent
 * so the automation's `prompt` is that agent's own label set. The prompt AND its
 * affirmative option are matched within the SAME current frame — never across an
 * accumulated history — so a stale phrase can't select a different dialog's
 * "Yes". Extending trust is adding an allowlist entry, never a broader match.
 */
export class TrustPromptResponder<A extends ElwoodAgentKind> {
  private readonly enabled: boolean;
  private readonly specs: readonly TrustPromptEntry[];
  private readonly settled = new Set<TrustPromptIdFor<A>>();

  constructor(agent: A, enabled = false) {
    this.enabled = enabled;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(frame: string, write: (input: string) => void): TrustPromptResult<A> {
    for (const spec of this.specs) {
      // `this.specs` was filtered to this agent in the constructor, so its ids
      // are this agent's label set even though the array type is the full union.
      const id = spec.id as TrustPromptIdFor<A>;
      // `always` prompts (Elwood's own hook bridge) answer regardless of
      // autotrust; every other trust prompt requires the caller's full-trust
      // posture so third-party trust is never granted implicitly.
      if (!(this.enabled || ("always" in spec && spec.always))) continue;
      if (this.settled.has(id) || !spec.visible.test(frame)) continue;
      // The answer must be THIS prompt's own affirmative option, present in the
      // same frame — not any generic "Yes" that might belong to another dialog.
      const option = acceptOption(frame, spec);
      if (option === undefined) {
        // Recognized but unanswerable: surface it ONCE rather than silently
        // continuing (which would leave the agent wedged with no signal).
        this.settled.add(id);
        return { kind: "unanswerable", prompt: id };
      }
      write(`${option}\r`);
      this.settled.add(id);
      return { kind: "answered", automation: { prompt: id, input: option } };
    }
    return undefined;
  }
}

/** True when any allowlisted trust prompt for `agent` is visible in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  return trustPromptAllowlist.some((spec) => spec.agent === agent && spec.visible.test(text));
}

/**
 * Finds THIS prompt's affirmative option, scoped to the prompt's own region of
 * the frame. The option must appear on or after the line where `spec.visible`
 * matches and before the region ends (a blank line or the start of a DIFFERENT
 * allowlisted prompt). This prevents a prompt's text pairing with a "Yes" that
 * actually belongs to a different, unrelated dialog rendered in the same frame
 * (e.g. "Hooks need review" above "Delete credentials? 1. Yes") — PRD §5.1.
 */
function acceptOption(frame: string, spec: TrustPromptEntry): string | undefined {
  const region = promptRegion(frame, spec);
  return numberedOptions(region).find((option) => spec.accept.test(option.label))?.number;
}

/**
 * The lines belonging to `spec`'s prompt: from its `visible` line to the region
 * end. `acceptOption` is only reached after `spec.visible.test(frame)` succeeded
 * and every `visible` pattern is line-local, so a matching line always exists;
 * `Math.max(0, …)` keeps the loop well-formed without an unreachable guard.
 */
function promptRegion(frame: string, spec: TrustPromptEntry): string {
  const lines = frame.split("\n");
  const start = Math.max(
    0,
    lines.findIndex((line) => spec.visible.test(line)),
  );
  const region: string[] = [];
  let sawOption = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    // A DIFFERENT dialog beginning ends this region — its options belong to that
    // dialog, not this prompt. That boundary is the header of another allowlisted
    // prompt, a fresh question line (ends with "?"), or a blank line once we have
    // already seen an option (so a "header\n\n  1. Yes" layout still works).
    const endsRegion =
      startsOtherPrompt(line, spec) || startsNewQuestion(line) || (sawOption && line.trim() === "");
    if (i > start && endsRegion) break;
    if (/(?:^|[\s›>])\d+[.)]/.test(line)) sawOption = true;
    region.push(line);
  }
  return region.join("\n");
}

/** True when `line` is the header of a different allowlisted prompt than `spec`. */
function startsOtherPrompt(line: string, spec: TrustPromptEntry): boolean {
  return trustPromptAllowlist.some((other) => other !== spec && other.visible.test(line));
}

/**
 * True when `line` reads as the start of a NEW dialog question (ends with "?"),
 * so an unrelated dialog rendered below the prompt (e.g. "Delete stored
 * credentials?") ends the prompt's option region even though it is not itself an
 * allowlisted prompt. This closes the same-frame cross-dialog isolation gap.
 */
function startsNewQuestion(line: string): boolean {
  return /\?\s*$/.test(line);
}

function numberedOptions(
  text: string,
): readonly { readonly number: string; readonly label: string }[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({ number: match[1]!, label: match[2]!.trim() }));
  });
}
