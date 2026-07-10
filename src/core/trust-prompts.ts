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

import type { ElwoodAgentKind } from "./activity.ts";

/**
 * The shape of one allowlisted trust prompt. The prompt and its answer are BOTH
 * matched within the same current frame: `visible` identifies the prompt, and
 * `accept` matches the exact affirmative option label in that same prompt. This
 * prevents a stale phrase from one frame pairing with a "Yes" from a different,
 * current dialog (which could auto-confirm an unrelated security gate). The
 * concrete `id` union is derived from the allowlist itself (see TrustPromptId).
 */
export type TrustPromptSpec = {
  /** Stable id used as the automation label and for once-only dedupe. */
  readonly id: string;
  readonly agent: ElwoodAgentKind;
  /** Identifies the prompt on the current rendered frame. Verified against the CLI versions below. */
  readonly visible: RegExp;
  /** Matches the exact affirmative option label for THIS prompt (per-prompt, not generic). */
  readonly accept: RegExp;
  /**
   * When true, answered regardless of `autotrust`. Reserved for trusting
   * Elwood's OWN integration (the hook bridge), which the session requires to
   * function at all — not third-party code. Third-party trust (skills, plugins,
   * MCP servers, folder trust) stays gated on the caller's full-trust posture.
   */
  readonly always?: boolean;
};

// Affirmative option shapes. Each rejects decline words so "No, ..." never matches.
const notDecline = "(?!.*\\b(no|without|not|quit|cancel|deny|don't)\\b)";
const yesOption = new RegExp(`^${notDecline}.*\\b(yes|trust|continue|proceed)\\b`, "i");
const useMcpOption = new RegExp(`^${notDecline}.*\\buse this(?:.*\\bMCP)? server`, "i");
// Codex hook trust's real affirmative is "Trust all and continue" / "Trust
// hooks" — matched specifically so a nearby unrelated dialog's generic "Yes,
// continue" (e.g. a credential prompt) can never be selected for hook trust.
const trustHooksOption = new RegExp(`^${notDecline}.*\\btrust\\b.*\\b(hooks?|all)\\b`, "i");

/**
 * The allowlist. Wording verified against claude 2.1.205 and codex-cli 0.142.5.
 * `workspace`/`directory` trust are the folder-trust gates; `skill`, `plugin`,
 * and `mcp` cover the CLI's first-run trust prompts for loading third-party
 * skills, plugins, and MCP servers under a full-trust launch.
 */
export const trustPromptAllowlist = [
  { id: "workspace_trust", agent: "claude", visible: /trust this folder/i, accept: yesOption },
  {
    id: "skill_trust",
    agent: "claude",
    visible: /trust (?:this|the) skill|load this skill/i,
    accept: yesOption,
  },
  { id: "plugin_trust", agent: "claude", visible: /trust (?:this|the) plugin/i, accept: yesOption },
  {
    // Real claude 2.1.205 prompt: "New MCP server found in this project" with an
    // affirmative option "Use this MCP server" (no "yes/trust/continue" word), so
    // it needs its own `accept` — the generic yes-matcher would leave it wedged.
    id: "mcp_trust",
    agent: "claude",
    visible: /New MCP server found|trust (?:this|the) MCP server|use this MCP server/i,
    accept: useMcpOption,
  },
  {
    // Codex's directory-trust gate keeps the stable `workspace_trust` label
    // (PRD §5.4) even though its wording differs from Claude's.
    id: "workspace_trust",
    agent: "codex",
    visible: /Do you trust the contents of this directory/i,
    accept: yesOption,
  },
  // Hook trust is Elwood's own integration, required for the session to work, so
  // it is always answered (not gated on autotrust) — see `always`.
  {
    id: "hook_trust",
    agent: "codex",
    visible: /Hooks need review/i,
    // Specific to hook trust's own option ("Trust all and continue"), never a
    // generic "Yes" that could belong to a different dialog in the same frame.
    accept: trustHooksOption,
    always: true,
  },
] as const satisfies readonly TrustPromptSpec[];

/**
 * The stable public `startup_prompt` trust labels (§5.4), derived from the
 * allowlist so the two can never drift: deleting or renaming an entry updates
 * this union, and a typo'd id fails `satisfies TrustPromptSpec` above.
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
    // An `always`-answered prompt (hook trust) is auto-handled, so it must NOT be
    // classified as human-blocking. Others block only when autotrust is off.
    (spec) => spec.agent === agent && !("always" in spec && spec.always) && !autotrust,
  );
}
