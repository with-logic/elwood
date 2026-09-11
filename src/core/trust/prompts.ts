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
import { trustPromptAllowlist } from "./allowlist.ts";

export { trustPromptAllowlist } from "./allowlist.ts";

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
/** The Claude trust-prompt ids: folder trust plus the CLI's first-run skill/plugin/MCP gates. */
type ClaudeTrustPromptId =
  | "workspace_trust"
  | "skill_trust"
  | "plugin_trust"
  | "mcp_trust"
  | "bypass_permissions";

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
