/**
 * Allowlist of known adapter startup trust prompts and how to answer them.
 * Implements PRD §5.1 and §5.5 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 *
 * This is an EXPLICIT allowlist, not an open-ended matcher: each entry names one
 * concrete prompt by its on-screen text and a fixed affirmative outcome. A new
 * CLI prompt is trusted only by adding a deliberate entry here — Elwood never
 * blanket-answers "any first-run confirmation", which would silently bypass a
 * future CLI security gate for third-party code or config.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { nonOptionText } from "../terminal-options.ts";

/**
 * The fields common to every allowlisted trust prompt. The prompt and its answer
 * are BOTH matched within the same current frame: `headerPattern` identifies the
 * prompt by its HEADER wording, and `accept` matches the exact affirmative option
 * label in that same prompt. This prevents a stale phrase from one frame pairing
 * with a "Yes" from a different, current dialog (which could auto-confirm an
 * unrelated security gate). `headerPattern` is a HEADER matcher, not a
 * whole-frame matcher: it is only safe when tested against the frame's non-option
 * lines (via `trustHeaderMatches`), never applied raw to the full frame.
 */
type TrustPromptBase = {
  /**
   * Identifies the prompt by its HEADER wording. MUST be tested only against the
   * frame's non-option lines (see `trustHeaderMatches`) — applying it raw to the
   * full frame would let an option-only trust phrase spoof recognition.
   * Verified against the CLI versions below.
   */
  readonly headerPattern: RegExp;
  /** Matches the exact affirmative option label for THIS prompt (per-prompt, not generic). */
  readonly accept: RegExp;
};

/**
 * When an allowlisted prompt is answered. `"autotrust"` prompts are answered ONLY
 * under the caller's full-trust posture; `"always"` prompts are answered
 * regardless of it (Elwood's own hook bridge, never third-party code).
 */
export type TrustAnswerPolicy = "always" | "autotrust";

/**
 * One allowlisted trust prompt, as an agent+id-DISCRIMINATED union so that (a) a
 * typo in `id` cannot compile into a public startup label, and (b)
 * `answerPolicy: "always"` — answered regardless of `autotrust` — is permitted
 * ONLY on Codex `hook_trust`, Elwood's OWN integration (the hook bridge) that the
 * session requires to work. Every third-party trust prompt (skills, plugins, MCP
 * servers, folder trust) is `answerPolicy: "autotrust"`, staying gated on the
 * caller's full-trust posture, so the invalid "third-party prompt answered
 * always" state is unrepresentable.
 */
export type TrustPromptSpec =
  | ({
      readonly agent: "claude";
      readonly id: ClaudeTrustPromptId;
      readonly answerPolicy: "autotrust";
    } & TrustPromptBase)
  | ({
      readonly agent: "codex";
      readonly id: "workspace_trust";
      readonly answerPolicy: "autotrust";
    } & TrustPromptBase)
  | ({
      readonly agent: "codex";
      readonly id: "hook_trust";
      /** Answered regardless of `autotrust`: Elwood's own hook bridge (never third-party code). */
      readonly answerPolicy: "always";
    } & TrustPromptBase);

/** The Claude trust-prompt ids: folder trust plus the CLI's first-run skill/plugin/MCP gates. */
type ClaudeTrustPromptId = "workspace_trust" | "skill_trust" | "plugin_trust" | "mcp_trust";

// Affirmative option shapes. Each rejects decline words so "No, ..." never matches.
const notDecline = "(?!.*\\b(no|without|not|quit|cancel|deny|don't)\\b)";
const yesOption = new RegExp(`^${notDecline}.*\\b(yes|trust|continue|proceed)\\b`, "i");
const useMcpOption = new RegExp(`^${notDecline}.*\\buse this(?:.*\\bMCP)? server`, "i");
// Codex hook trust's real affirmative is "Trust all and continue" / "Trust
// hooks" — matched specifically so a nearby unrelated dialog's generic "Yes,
// continue" (e.g. a credential prompt) can never be selected for hook trust.
const trustHooksOption = new RegExp(`^${notDecline}.*\\btrust\\b.*\\b(hooks?|all)\\b`, "i");

/**
 * The allowlist. Wording verified against claude 2.1.205–2.1.252 and codex-cli 0.142.5.
 * `workspace`/`directory` trust are the folder-trust gates; `skill`, `plugin`,
 * and `mcp` cover the CLI's first-run trust prompts for loading third-party
 * skills, plugins, and MCP servers under a full-trust launch.
 */
// Each `headerPattern` matches the prompt's QUESTION/HEADER wording — never a
// phrase that lives only in an affirmative option — so recognition anchors on a
// header line (matched via `trustHeaderMatches` over the frame's non-option
// text), which a hostile option cannot spoof (PRD §5.1).
export const trustPromptAllowlist = [
  {
    // Header renders as "Do you trust this folder?" or "Quick safety check: Is
    // this a project you created or one you trust?" (claude 2.1.205/2.1.206).
    id: "workspace_trust",
    agent: "claude",
    headerPattern: /do you trust this folder|project you .*\bor one you trust/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  {
    id: "skill_trust",
    agent: "claude",
    headerPattern: /do you (?:want to )?(?:trust|load) (?:this|the) skill|load this skill\?/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  {
    id: "plugin_trust",
    agent: "claude",
    headerPattern: /do you (?:want to )?trust (?:this|the) plugin|trust the plugin\?/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  {
    // Header "New MCP server found in this project"; the affirmative option is
    // "Use this MCP server" (no yes/trust/continue word), needing a per-prompt
    // accept — the generic yes-matcher would leave it wedged.
    id: "mcp_trust",
    agent: "claude",
    headerPattern: /New MCP server found|do you trust (?:this|the) MCP server/i,
    accept: useMcpOption,
    answerPolicy: "autotrust",
  },
  {
    // Codex's directory-trust gate keeps the stable `workspace_trust` label
    // (PRD §5.4) even though its wording differs from Claude's.
    id: "workspace_trust",
    agent: "codex",
    headerPattern: /Do you trust the contents of this directory/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  // Hook trust is Elwood's own integration, required for the session to work, so
  // it is always answered (not gated on autotrust) — see `answerPolicy: "always"`.
  {
    id: "hook_trust",
    agent: "codex",
    headerPattern: /Hooks need review/i,
    // Specific to hook trust's own option ("Trust all and continue"), never a
    // generic "Yes" that could belong to a different dialog in the same frame.
    accept: trustHooksOption,
    answerPolicy: "always",
  },
] as const satisfies readonly TrustPromptSpec[];

/**
 * True when `spec`'s HEADER wording appears in `header` — the frame's NON-option
 * text as produced by `nonOptionText`. This is the ONE shared, option-aware
 * recognizer: the responder, the cursor navigator, and the screen-fact blocking
 * rules all go through it (each computes `nonOptionText` once per frame and
 * tests every spec against that), so a numbered or cursor-selectable option whose
 * label merely contains a trust phrase is never recognized as a prompt. Matching
 * joined non-option lines also keeps wrapped headers matchable (§5.1).
 */
export function trustHeaderMatches(header: string, spec: TrustPromptBase): boolean {
  return spec.headerPattern.test(header);
}

/** `trustHeaderMatches` over a raw frame, for callers that test a single spec. */
export function trustPromptHeaderVisible(frame: string, spec: TrustPromptBase): boolean {
  return trustHeaderMatches(nonOptionText(frame), spec);
}

/**
 * The stable public `startup_prompt` trust labels (§5.4), derived from the
 * allowlist so the two can never drift: deleting, adding, or renaming an entry
 * updates this union automatically. Because `TrustPromptSpec` fixes each agent's
 * ids to a closed literal union, a typo in an entry's `id` fails to compile
 * against `satisfies` rather than silently widening this derived label union.
 */
export type TrustPromptId = (typeof trustPromptAllowlist)[number]["id"];

/** The trust label ids for one specific agent (e.g. Codex automation cannot use a Claude-only id). */
export type TrustPromptIdFor<A extends ElwoodAgentKind> = Extract<
  (typeof trustPromptAllowlist)[number],
  { readonly agent: A }
>["id"];

/** Specs for one agent that stay UNANSWERED under the effective policy (block on the human). */
export function blockingTrustSpecs(
  agent: ElwoodAgentKind,
  autotrust: boolean,
): readonly TrustPromptSpec[] {
  return trustPromptAllowlist.filter(
    // An `answerPolicy: "always"` prompt (hook trust) is auto-handled, so it must
    // NOT be classified as human-blocking. Others block only when autotrust is off.
    (spec) => spec.agent === agent && spec.answerPolicy !== "always" && !autotrust,
  );
}
