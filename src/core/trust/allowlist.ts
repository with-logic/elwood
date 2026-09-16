/**
 * The allowlisted startup trust prompts and the affirmative option each one
 * accepts, kept apart from the matching logic in `prompts.ts` so the wording
 * table can grow without crowding it.
 * Implements PRD §5.1/§5.4/§5.5 (C-CLAUDE-10, C-CLAUDE-14, C-CLAUDE-21, C-CODEX-15).
 */

import type { TrustPromptSpec } from "./prompts.ts";

// Affirmative option shapes. Each rejects decline words so "No, ..." never
// matches. Prompts with a SPECIFIC affirmative (MCP, hook trust, bypass
// acceptance) get their own matcher so a nearby dialog's generic "Yes" cannot
// be selected for them.
const notDecline = "(?!.*\\b(no|without|not|quit|cancel|deny|don't)\\b)";
const yesOption = new RegExp(`^${notDecline}.*\\b(yes|trust|continue|proceed)\\b`, "i");
const useMcpOption = new RegExp(`^${notDecline}.*\\buse this(?:.*\\bMCP)? server`, "i");
const trustHooksOption = new RegExp(`^${notDecline}.*\\btrust\\b.*\\b(hooks?|all)\\b`, "i");
const acceptOption = new RegExp(`^${notDecline}.*\\byes\\b.*\\baccept\\b`, "i");

/**
 * The allowlist. Wording verified against claude 2.1.205–2.1.268 and codex-cli 0.142.5.
 * `workspace`/`directory` trust are the folder-trust gates; `skill`, `plugin`,
 * and `mcp` cover the CLI's first-run trust prompts for loading third-party
 * skills, plugins, and MCP servers under a full-trust launch.
 */
// Each `headerPattern` matches the prompt's QUESTION/HEADER wording — never a
// phrase that lives only in an affirmative option — so recognition anchors on a
// standalone header inside the active dialog; option and transcript wording
// cannot supply authority to another dialog (PRD §5.4).
export const trustPromptAllowlist = [
  {
    // Header renders as "Do you trust this folder?" or "Quick safety check: Is
    // this a project you created or one you trust?" (claude 2.1.205/2.1.206).
    id: "workspace_trust",
    agent: "claude",
    headerPattern:
      /^(?:do you trust this folder|(?:Quick safety check:\s*)?Is this a project you .*\bor one you trust)/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  {
    id: "skill_trust",
    agent: "claude",
    headerPattern: /^(?:do you (?:want to )?(?:trust|load) (?:this|the) skill|load this skill\?)/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  {
    id: "plugin_trust",
    agent: "claude",
    headerPattern: /^(?:do you (?:want to )?trust (?:this|the) plugin|trust the plugin\?)/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  {
    // Header "New MCP server found in this project"; the affirmative option is
    // "Use this MCP server" (no yes/trust/continue word), needing a per-prompt
    // accept — the generic yes-matcher would leave it wedged.
    id: "mcp_trust",
    agent: "claude",
    headerPattern: /^(?:New MCP server found|do you trust (?:this|the) MCP server)/i,
    accept: useMcpOption,
    answerPolicy: "autotrust",
  },
  {
    // Claude's one-time bypassPermissions disclaimer: "WARNING: Claude Code
    // running in Bypass Permissions mode", "Yes, I accept" / "No, exit"
    // (C-CLAUDE-21). "running in" keeps the live footer from matching.
    id: "bypass_permissions",
    agent: "claude",
    headerPattern: /^(?:WARNING:\s*)?Claude Code running in Bypass Permissions mode/i,
    accept: acceptOption,
    answerPolicy: "autotrust",
  },
  {
    // Codex's directory-trust gate keeps the stable `workspace_trust` label
    // (PRD §5.4) even though its wording differs from Claude's.
    id: "workspace_trust",
    agent: "codex",
    headerPattern: /^Do you trust the contents of this directory/i,
    accept: yesOption,
    answerPolicy: "autotrust",
  },
  // Codex trusts every configured hook, including third-party hooks, because the
  // bridge requires hook trust. This is session-wide and independent of autotrust.
  {
    id: "hook_trust",
    agent: "codex",
    headerPattern: /^Hooks need review/i,
    // Specific to hook trust's own option ("Trust all and continue"), never a
    // generic "Yes" that could belong to a different dialog in the same frame.
    accept: trustHooksOption,
    answerPolicy: "always",
  },
] as const satisfies readonly TrustPromptSpec[];
