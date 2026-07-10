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
  private readonly settled = new Set<TrustPromptIdFor<A>>();

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
      // Recognize the prompt by its `visible` phrase (which real prompts may put
      // in the question OR in an affirmative option like "1. Yes, I trust this
      // folder"). The region is the contiguous dialog block around that match,
      // bounded so a different dialog in the same frame is excluded (PRD §5.1).
      const region = promptRegion(lines, spec);
      if (this.settled.has(id) || region === undefined) continue;
      // No numbered options in the region yet: the dialog is still RENDERING
      // (question drawn, choices not). Skip — retry next frame — rather than
      // wedging it as unanswerable. `continue` (not return) so a different,
      // fully-rendered prompt in the same frame can still be handled this pass.
      if (!hasAnyOption(region)) continue;
      // Options are present. The answer must be THIS prompt's own CLEAN affirmative
      // option — not a generic "Yes" from another dialog, and never an option that
      // riders a destructive action ("... and delete stored credentials").
      const option = matchOption(region, spec);
      if (option === undefined) {
        // Fully rendered but no acceptable option: genuinely unanswerable. Surface
        // it ONCE rather than silently continuing (which would wedge the agent).
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
 * The contiguous dialog block that CONTAINS `spec.visible` — real prompts may put
 * the trust phrase in the question OR in an affirmative option, so recognition is
 * by region, not a header line. The block runs from the line after the previous
 * boundary (a blank line, a fresh question, or a different allowlisted prompt)
 * above the match, down to the next boundary below it. Returns undefined when the
 * phrase is absent, so a different, unrelated dialog never contributes its option.
 */
function promptRegion(lines: readonly string[], spec: TrustPromptEntry): string | undefined {
  const match = lines.findIndex((line) => spec.visible.test(line));
  if (match === -1) return undefined;
  let start = match;
  while (start > 0 && !isBoundaryAbove(lines[start] as string, spec)) start--;
  const region: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    if (i > start && isBoundaryAbove(line, spec)) break;
    region.push(line);
  }
  return region.join("\n");
}

/**
 * True when `line` begins a NEW dialog block (so it bounds the current region):
 * a blank line, a fresh question (ends "?"), or a different allowlisted prompt's
 * visible phrase. Ending at every such boundary keeps an unrelated dialog in the
 * same frame from ever contributing its "Yes" (PRD §5.1).
 */
function isBoundaryAbove(line: string, spec: TrustPromptEntry): boolean {
  if (line.trim() === "" || /\?\s*$/.test(line)) return true;
  return trustPromptAllowlist.some(
    (other) => other !== spec && !spec.visible.test(line) && other.visible.test(line),
  );
}

/** True when an affirmative label riders a destructive/irreversible action. */
function carriesDestructiveRider(label: string): boolean {
  return /\b(delete|remove|wipe|erase|destroy|overwrite|revoke|disable|uninstall)\b/i.test(label);
}

function numberedOptions(
  text: string,
): readonly { readonly number: string; readonly label: string }[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({ number: match[1]!, label: match[2]!.trim() }));
  });
}
