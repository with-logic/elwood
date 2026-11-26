/** Native trust option rows and gate-bound footers; unrelated text cannot masquerade as either (C-TRUST-01, C-CODEX-15, C-CLAUDE-28). */

export const claudeWorkspaceOptions =
  /^(?:Yes(?:, (?:I trust this folder|proceed|continue))?|No(?:, (?:exit|cancel))?)$/i;
export const claudeExtensionOptions =
  /^(?:Yes(?:, (?:trust it|load this skill|continue))?|No(?:, (?:exit|cancel))?)$/i;
export const claudeMcpOptions =
  /^(?:Use this(?: MCP)? server|Use this and all future MCP servers in this project|Use all future servers|Continue without using this MCP server|No(?:, (?:exit|cancel))?)$/i;
export const claudeBypassOptions = /^(?:Yes, I accept|No, exit)$/i;
export const codexWorkspaceOptions = /^(?:Yes(?:, continue)?|No(?:, quit)?)$/i;
export const codexHookReviewLabels = [
  "Review hooks",
  "Trust all and continue",
  "Continue without trusting (hooks won't run)",
] as const;
export const codexHooksOptions = new RegExp(
  `^(?:${codexHookReviewLabels.map(RegExp.escape).join("|")})$`,
  "i",
);

// Codex 0.164 draws `Back to Agent Command Center` for `Quit` when hook trust is not bypassed.
export const codexFolderAccessLabels = {
  accept: "Trust and continue",
  quit: "Quit",
  back: "Back to Agent Command Center",
} as const;
export const codexFolderAccessAccept = new RegExp(
  `^${RegExp.escape(codexFolderAccessLabels.accept)}$`,
);
export const codexFolderAccessOptions = new RegExp(
  `^(?:${Object.values(codexFolderAccessLabels).map(RegExp.escape).join("|")})$`,
);

// Unlike the generic native footers, each of these belongs to one gate and ends a dialog only
// under that gate (`TrustPromptSpec.footer`): Codex 0.164's when hook trust is not bypassed,
// and Claude's MCP server prompt's.
export const codexFolderAccessFooter = "enter continue · esc back";
export const codexHooksFooter = "enter confirm · esc skip";
export const claudeMcpFooter = "Enter to confirm · Esc to reject";
export const gateFooters = [codexFolderAccessFooter, codexHooksFooter, claudeMcpFooter] as const;
export type GateFooter = (typeof gateFooters)[number];
