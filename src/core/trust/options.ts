/** Native trust option rows; unrelated text cannot masquerade as a cursor sibling (C-TRUST-01). */

export const claudeWorkspaceOptions =
  /^(?:Yes(?:, (?:I trust this folder|proceed|continue))?|No(?:, (?:exit|cancel))?)$/i;
export const claudeExtensionOptions =
  /^(?:Yes(?:, (?:trust it|load this skill|continue))?|No(?:, (?:exit|cancel))?)$/i;
export const claudeMcpOptions =
  /^(?:Use this(?: MCP)? server|Use this and all future MCP servers in this project|Use all future servers|Continue without using this MCP server|No(?:, (?:exit|cancel))?)$/i;
export const claudeBypassOptions = /^(?:Yes, I accept|No, exit)$/i;
export const codexWorkspaceOptions = /^(?:Yes(?:, continue)?|No(?:, quit)?)$/i;
export const codexHooksOptions =
  /^(?:Review hooks|Trust all and continue|Continue without trusting \(hooks won't run\))$/i;

export const codexFolderAccessOptions = /^(?:Trust and continue|Quit)$/;
