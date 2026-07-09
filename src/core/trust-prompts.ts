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
 * The bounded set of stable trust-prompt ids. These are PRD-stable public
 * `startup_prompt` labels (§5.4), so the union keeps a typo from compiling into
 * a contract-breaking label.
 */
export type TrustPromptId =
  | "workspace_trust"
  | "skill_trust"
  | "plugin_trust"
  | "mcp_trust"
  | "hook_trust";

/** One allowlisted trust prompt: a stable id, the agent, and its wording. */
export type TrustPromptSpec = {
  /** Stable id used as the automation label and for once-only dedupe. */
  readonly id: TrustPromptId;
  readonly agent: ElwoodAgentKind;
  /** Matches the prompt on the rendered screen. Verified against the CLI versions noted below. */
  readonly visible: RegExp;
  /**
   * When true, answered regardless of `autotrust`. Reserved for trusting
   * Elwood's OWN integration (the hook bridge), which the session requires to
   * function at all — not third-party code. Third-party trust (skills, plugins,
   * MCP servers, folder trust) stays gated on the caller's full-trust posture.
   */
  readonly always?: boolean;
};

/**
 * The allowlist. Wording verified against claude 2.1.205 and codex-cli 0.142.5.
 * `workspace`/`directory` trust are the folder-trust gates; `skill`, `plugin`,
 * and `mcp` cover the CLI's first-run trust prompts for loading third-party
 * skills, plugins, and MCP servers under a full-trust launch.
 */
export const trustPromptAllowlist: readonly TrustPromptSpec[] = [
  { id: "workspace_trust", agent: "claude", visible: /trust this folder/i },
  { id: "skill_trust", agent: "claude", visible: /trust (?:this|the) skill|load this skill/i },
  { id: "plugin_trust", agent: "claude", visible: /trust (?:this|the) plugin/i },
  {
    id: "mcp_trust",
    agent: "claude",
    visible: /trust (?:this|the) MCP server|use this MCP server/i,
  },
  {
    // Codex's directory-trust gate keeps the stable `workspace_trust` label
    // (PRD §5.4) even though its wording differs from Claude's.
    id: "workspace_trust",
    agent: "codex",
    visible: /Do you trust the contents of this directory/i,
  },
  // Hook trust is Elwood's own integration, required for the session to work, so
  // it is always answered (not gated on autotrust) — see `always`.
  { id: "hook_trust", agent: "codex", visible: /Hooks need review/i, always: true },
];

/** The trust-prompt matchers for one agent, for screen-fact blocking detection. */
export function trustPromptPatterns(agent: ElwoodAgentKind): readonly RegExp[] {
  return trustPromptAllowlist.filter((spec) => spec.agent === agent).map((spec) => spec.visible);
}

/**
 * Selects the affirmative numbered option: a positively-worded option
 * ("yes"/"trust"/"continue") that is not a decline ("no"/"without"/"cancel").
 */
export const affirmativeOptionPattern =
  /^(?!.*\b(no|without|not|quit|cancel|deny)\b).*\b(yes|trust|continue|proceed)\b/i;
