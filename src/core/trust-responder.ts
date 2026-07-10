/**
 * Detects and answers the allowlisted family of adapter startup trust prompts.
 * Implements PRD §5.1 and §9.1 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
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
 * verified affirmative option is absent (so it cannot be safely auto-answered),
 * or nothing.
 */
export type TrustPromptResult<A extends ElwoodAgentKind = ElwoodAgentKind> =
  | { readonly kind: "answered"; readonly automation: TrustPromptAutomation<A> }
  | { readonly kind: "unanswerable"; readonly prompt: TrustPromptIdFor<A> }
  | undefined;

/**
 * Answers each allowlisted trust prompt for one agent at most once. Third-party
 * trust prompts are answered only when `enabled` (the caller's full-trust /
 * autotrust posture); an `always` prompt (Elwood's OWN hook bridge — see
 * `TrustPromptSpec.always`) is answered regardless of `enabled`. Generic in the
 * agent so the automation's `prompt` is that agent's own label set. The prompt
 * AND its affirmative option are matched within the SAME current frame, scoped to
 * the prompt's own region — never across accumulated history or a different
 * dialog's option. Extending trust is adding an allowlist entry, never a broader
 * match.
 */
export class TrustPromptResponder<A extends ElwoodAgentKind> {
  private readonly enabled: boolean;
  private readonly specs: readonly TrustPromptEntry[];
  // A prompt is `settled` once ANSWERED (never re-answer the same prompt).
  private readonly settled = new Set<TrustPromptIdFor<A>>();
  // A prompt whose unanswerable wedge has already been reported once. Kept SEPARATE
  // from `settled`: an unanswerable outcome must NOT block a later frame — the real
  // affirmative option may render after a partial frame — so we can still answer it.
  private readonly reportedUnanswerable = new Set<TrustPromptIdFor<A>>();

  constructor(agent: A, enabled = false) {
    this.enabled = enabled;
    this.specs = trustPromptAllowlist.filter((spec) => spec.agent === agent);
  }

  /** `frame` MUST be the CURRENT rendered screen, not an accumulated buffer. */
  handle(frame: string, write: (input: string) => void): TrustPromptResult<A> {
    const lines = frame.split("\n");
    for (const spec of this.specs) {
      // `this.specs` was filtered to this agent in the constructor, so its ids
      // are this agent's label set even though the array type is the full union.
      const id = spec.id as TrustPromptIdFor<A>;
      // `always` prompts (Elwood's own hook bridge) answer regardless of
      // autotrust; every other trust prompt requires the caller's full-trust
      // posture so third-party trust is never granted implicitly.
      if (!(this.enabled || ("always" in spec && spec.always))) continue;
      // Recognize the prompt ONLY by its `visible` HEADER wording on a non-option
      // line (never an option label), so a hostile option can't spoof a prompt.
      // The region is that dialog's block (header → prose → options), ending at a
      // different allowlisted prompt's header (PRD §5.1).
      const region = promptRegion(lines, spec);
      if (this.settled.has(id) || region === undefined) continue;
      // No numbered options in the region yet: the dialog is still RENDERING
      // (question drawn, choices not). Skip — retry next frame — rather than
      // wedging it as unanswerable. `continue` (not return) so a different,
      // fully-rendered prompt in the same frame can still be handled this pass.
      if (!hasAnyOption(region)) continue;
      // Options are present. The answer must be a CLEAN affirmative for THIS
      // prompt (its specific accept, never a generic Yes), and never an option that
      // riders a destructive action ("... and delete stored credentials").
      const option = matchOption(region, spec);
      if (option === undefined) {
        // Options present but none acceptable YET. This can be a partial render
        // (a non-affirmative option drew before the affirmative), so do NOT settle
        // — a later frame with the real option can still answer. Report the wedge
        // ONCE (durable warning), then keep watching on subsequent frames.
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

/** True when an allowlisted trust prompt for `agent` has a visible region in `text`. */
export function trustPromptVisible(text: string, agent: ElwoodAgentKind): boolean {
  const lines = text.split("\n");
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && promptRegion(lines, spec) !== undefined,
  );
}

/** True when the prompt's own region contains at least one numbered option. */
function hasAnyOption(region: string): boolean {
  return numberedOptions(region).length > 0;
}

/**
 * THIS prompt's affirmative option number within its own region, or undefined
 * when no option matches `spec.accept` OR the matched option riders a destructive
 * action (see `carriesDestructiveRider`). The region is scoped to the prompt, and
 * the affirmative must be a CLEAN affirmative — so "1. Yes, trust this plugin and
 * delete stored credentials" is never auto-confirmed (PRD §5.1).
 */
function matchOption(region: string, spec: TrustPromptEntry): string | undefined {
  return numberedOptions(region).find(
    (option) => spec.accept.test(option.label) && !carriesDestructiveRider(option.label),
  )?.number;
}

/**
 * The dialog region for `spec`: recognized by its HEADER (its `visible` phrase in
 * the NON-OPTION lines — never an option line, so a hostile option can't spoof a
 * prompt — joined so a header wrapped across rows still matches). A real trust
 * dialog renders header → blank/descriptive lines → options as ONE dialog, so the
 * region spans blanks and prose; it ends only where a DIFFERENT allowlisted
 * prompt's header begins (a second trust dialog in the same frame). Returns the
 * lines of the recognized dialog, or undefined when no header matches.
 */
function promptRegion(lines: readonly string[], spec: TrustPromptEntry): string | undefined {
  // Anchor on this spec's own HEADER — the first non-option line from which the
  // forward run of non-option lines (up to the next different prompt) joins to
  // match `spec.visible`. Joining supports a header wrapped across rows; testing
  // only non-option lines means an option-only phrase never anchors, so a hostile
  // option ("1. Yes, trust this plugin ...") can't spoof a prompt (PRD §5.1).
  for (let start = 0; start < lines.length; start++) {
    if (isOptionLine(lines[start] as string)) continue;
    const end = regionEnd(lines, start, spec);
    const header = lines
      .slice(start, end)
      .filter((line) => !isOptionLine(line))
      .join(" ");
    if (spec.visible.test(header)) return lines.slice(start, end).join("\n");
  }
  return undefined;
}

/**
 * Where `spec`'s region ends: the next DIFFERENT allowlisted prompt's header, or
 * EOF. The region deliberately spans the blank and descriptive lines within one
 * trust dialog — a real prompt renders header → prose → options as ONE dialog,
 * and a wrapped header's own question mark must not split it — so detection just
 * answers the recognized dialog (Steve's directive: never leave the agent waiting
 * on a trust gate under autotrust). Anti-spoof and destructive-rider protections
 * (see promptRegion / carriesDestructiveRider) remain the security guarantees.
 */
function regionEnd(lines: readonly string[], start: number, spec: TrustPromptEntry): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (!isOptionLine(lines[i] as string) && startsOtherPrompt(lines[i] as string, spec)) return i;
  }
  return lines.length;
}

/** True when `line` is itself a numbered option (e.g. "1. ...", "› 2) ..."). */
function isOptionLine(line: string): boolean {
  return /(?:^|[\s›>])\d+[.)]/.test(line);
}

/** True when `line` is the header of a DIFFERENT allowlisted prompt than `spec`. */
function startsOtherPrompt(line: string, spec: TrustPromptEntry): boolean {
  return trustPromptAllowlist.some(
    (other) => other !== spec && !isOptionLine(line) && other.visible.test(line),
  );
}

/** True when an affirmative label riders a destructive/irreversible action. */
function carriesDestructiveRider(label: string): boolean {
  return /\b(delete|remove|wipe|erase|destroy|overwrite|revoke|disable|uninstall)\b/i.test(label);
}
