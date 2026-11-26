/**
 * Recognized native trust-dialog explanations, excluding arbitrary intervening prose.
 * Implements PRD §5.4/C-TRUST-01/C-CLAUDE-26/C-CLAUDE-28/C-CLAUDE-29/C-CLAUDE-30. Claude copy is
 * captured in trust-responder-cursor, trust-bypass-permissions, claude-workspace-trust-hooks,
 * claude-workspace-load-rows, claude-workspace-permissions and claude-mcp-server-prompt tests, the
 * last four from `tests/fixtures/claude-2.1.329/trust/` and `tests/fixtures/claude-2.1.332/trust/`;
 * Codex directory/hooks were captured from 0.154.0.
 *
 * A prompt with known copy REQUIRES an explanatory sentence before any key is
 * written: a bare allowlisted header is a hold-only candidate, never a verified
 * dialog. Only version-variable rows (a count, a link label, a later sentence) and the rows a
 * folder's settings draw stay optional: Claude's load row, its hooks warning, and its
 * permissions warning, whose rules are the folder's own opaque text. Any other prose fails
 * closed.
 */

/** Skill and plugin gates have no captured explanatory copy; none is accepted. */
export const noTrustDescription = /^$/;

/** The body of Claude's prompt for one new project MCP server, captured from 2.1.332. */
export const claudeMcpDescription =
  /^MCP servers may execute code or access system resources\. All tool calls require approval\. Learn more in the MCP documentation\.$/;

// Whole sentences only, so a half-painted body never validates. Either sentence
// proves the native body; 2.1.206 omits ", or work from your team".
const likeYourOwn = String.raw`\(Like your own code, a well-known open source project(?:, or work from your team)?\)\. If not, take a moment to review what's in this folder first\.`;
const ableTo = String.raw`Claude Code'll be able to read, edit, and execute files here\.`;
// Claude 2.1.326 and later add a load row after `ableTo`, naming what trusting the folder
// loads: each project settings file that parses, `.claude/settings.json` then
// `.claude/settings.local.json`, then `.mcp.json here or above (MCP servers)` when a folder
// declares MCP servers. A settings file whose hooks, status line command, or helpers run
// commands carries ` (runs commands)`, and Claude 2.1.329 and later put a hooks warning before
// the row, naming exactly those files, and a permissions warning before both
// (`optionalPermissionsWarning`). Items join as Claude's lists do: `a`, `a and b`,
// `a, b, and c`. Only these combinations verify. A file marked as running commands that the
// hooks warning does not name, either hooks row alone, or any other annotation or warning is
// unknown prose and fails closed.
const fileLoads = ["absent", "loads", "runs"] as const;
type FileLoad = (typeof fileLoads)[number];
const settingsFiles = [
  String.raw`\.claude/settings\.json`,
  String.raw`\.claude/settings\.local\.json`,
] as const;
/** A `V` for each of `T`'s entries, so the tuple grows with `T`. */
type EachOf<T extends readonly unknown[], V> = { readonly [entry in keyof T]: V };
/** How each of `settingsFiles` appears in a load row, in its order. */
type SettingsLoads = EachOf<typeof settingsFiles, FileLoad>;
type LoadDisclosure = { readonly settingsLoads: SettingsLoads; readonly mcpServers: boolean };
const mcpServersItem = String.raw`\.mcp\.json here or above \(MCP servers\)`;
// Claude closes its permissions, added-directories, and headers-helper warnings with this one
// sentence on its own row; only the permissions warning is recognized.
const closingSentence =
  "These will apply without asking. Only proceed if you trust this configuration.";
const permissionsHeader = "⚠ This folder pre-approves ";
type SettingsFilePattern = (typeof settingsFiles)[number];
const loadDisclosures: readonly LoadDisclosure[] = fileLoads
  .flatMap((settings) => fileLoads.map((local): SettingsLoads => [settings, local]))
  .flatMap((settingsLoads) => [false, true].map((mcpServers) => ({ settingsLoads, mcpServers })))
  .filter(
    ({ settingsLoads, mcpServers }) =>
      mcpServers || settingsLoads.some((load) => load !== "absent"),
  );
const warnedRows = loadDisclosures
  .map((disclosure) => `${optionalPermissionsWarning(disclosure)}${disclosureRows(disclosure)}`)
  .join("|");
const ableToRows = `${ableTo}\\s*(?:(?:${warnedRows})\\s*)?`;
export const claudeWorkspaceDescription = new RegExp(
  `^(?:${likeYourOwn}\\s*(?:${ableToRows})?|${ableToRows})(?:Security guide)?$`,
);

// The first that applies wins, so a row naming several reports the most consequential (§5.3),
// and `settings`, which every load row matches, means settings files with neither of the others.
const disclosureOrder = ["hooks", "mcp_servers", "settings"] as const;
/** What a verified load row says trusting the folder loads. */
export type ClaudeWorkspaceDisclosure = (typeof disclosureOrder)[number];
const hooksRows = disclosurePattern(
  loadDisclosures.filter(({ settingsLoads }) => settingsLoads.includes("runs")),
);
const disclosurePatterns: Readonly<Record<ClaudeWorkspaceDisclosure, RegExp>> = {
  hooks: hooksRows,
  mcp_servers: disclosurePattern(loadDisclosures.filter(({ mcpServers }) => mcpServers)),
  settings: disclosurePattern(loadDisclosures),
};

/**
 * The most consequential thing verified Claude workspace copy says trusting the folder loads:
 * settings files that run commands (hooks, a status line command, or helpers), then MCP
 * servers, then settings files at all. Undefined for the plain prompt, which has no load row.
 */
export function claudeWorkspaceStrongestDisclosure(
  copy: string,
): ClaudeWorkspaceDisclosure | undefined {
  return disclosureOrder.find((disclosure) => disclosurePatterns[disclosure].test(copy));
}

/** Whether verified Claude workspace copy discloses hooks, which trusting the folder runs. */
export function claudeWorkspaceDisclosesHooks(copy: string): boolean {
  return hooksRows.test(copy);
}

/**
 * The rows for any of `disclosures` at the end of verified copy. Claude's own rows always end
 * it, so a hooks warning or load row quoted in the folder's permission rules, which the real
 * closing sentence follows, can never be read as what the prompt discloses.
 */
function disclosurePattern(disclosures: readonly LoadDisclosure[]): RegExp {
  return new RegExp(`(?:${disclosures.map(disclosureRows).join("|")})\\s*(?:Security guide)?$`);
}

/** A disclosure's rows: the hooks warning, if a file runs commands, then the load row. */
function disclosureRows({ settingsLoads, mcpServers }: LoadDisclosure): string {
  const running = settingsFiles.filter((_, index) => settingsLoads[index] === "runs");
  const items = settingsFiles.flatMap((file, index) => {
    if (settingsLoads[index] === "absent") return [];
    return [settingsLoads[index] === "runs" ? String.raw`${file} \(runs commands\)` : file];
  });
  const load = `Trusting this folder loads ${joinAsClaudeList([...items, ...(mcpServers ? [mcpServersItem] : [])])}\\.`;
  if (running.length === 0) return load;
  const warning = `⚠ This folder configures hooks that can run commands without asking, declared in ${joinAsClaudeList(running)}`;
  return `${warning}\\s*${load}`;
}

/**
 * The optional warning for pre-approved tool permissions before a disclosure's rows, naming
 * any of the settings files its load row names. The rules between its header and the closing
 * sentence are the folder's own text, so they are opaque: at least one non-blank character,
 * none of them a warning sign, so another warning before the closing sentence fails closed,
 * and nothing is read from them. Lazy is enough: the description is anchored, so the match
 * still has to end at the real closing sentence before the real rows.
 */
function optionalPermissionsWarning({ settingsLoads }: LoadDisclosure): string {
  const loaded = settingsFiles.filter((_, index) => settingsLoads[index] !== "absent");
  if (loaded.length === 0) return "";
  // Every non-empty subset of `loaded`, in its order.
  const namedFileLists: (readonly SettingsFilePattern[])[] = [];
  for (const file of loaded) {
    for (const subset of [...namedFileLists]) namedFileLists.push([...subset, file]);
    namedFileLists.push([file]);
  }
  const count = String.raw`(?:1 tool permission|(?:[2-9]|[1-9]\d+) tool permissions)`;
  const files = namedFileLists.map((subset) => joinAsClaudeList(subset)).join("|");
  return `(?:${permissionsHeader}${count} in (?:${files}):\\s*[^\\s⚠][^⚠]*?\\s*${RegExp.escape(closingSentence)}\\s*)?`;
}

/**
 * Whether a Claude workspace prompt's permissions warning, when it has one, ends at Claude's own
 * closing sentence (C-CLAUDE-30): a whole row, followed by a blank row or a warning. Claude
 * always draws one of those after it, since a load row follows the warning. The folder's rules
 * can draw neither a blank row nor `⚠`, and Claude cuts each rule at about 57 characters and
 * joins them with `, ` and ` and `, so no rules row is ever the whole sentence: a rule that
 * quotes it never stands in for the row Claude draws.
 */
export function claudePermissionsCloseIsNative(rows: readonly string[]): boolean {
  const start = rows.findIndex((row) => row.startsWith(permissionsHeader));
  if (start < 0) return true;
  const end = rows.findIndex((row, index) => index > start && (row === "" || row.startsWith("⚠")));
  // With no row after the block, `end` is -1 and `rows[-2]` is undefined: not Claude's layout.
  return rows[end - 1] === closingSentence;
}

/** Claude's list join: `a`, `a and b`, `a, b, and c`. */
function joinAsClaudeList(items: readonly string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// 2.1.268 shows the first sentence and the acceptance; 2.1.310 adds the sandbox sentence
// between them and the security-guide link below. Only the first sentence is required.
const bypassNoApproval = String.raw`In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands\.`;
const bypassSandboxOnly = String.raw`This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged\.`;
const bypassResponsibility = String.raw`By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode\.`;
const securityGuide = String.raw`https://code\.claude\.com/docs/en/security`;
export const claudeBypassDescription = new RegExp(
  `^${bypassNoApproval}\\s*(?:${bypassSandboxOnly}\\s*)?(?:${bypassResponsibility}\\s*)?(?:${securityGuide})?$`,
);

export const codexWorkspaceDescription =
  /^Working with untrusted contents comes with higher risk of prompt injection\. Trusting the directory allows project-local config, hooks, and exec policies to load\.$/;

export const codexHooksDescription =
  /^(?:\d+ hooks? (?:is|are) new or changed\.\s*)?Hooks can run outside the sandbox after you trust them\.$/;

/** Codex 0.156.1 folder access copy, captured through the native PTY. */
export const codexFolderAccessDescription =
  /^Codex can read, edit, and run files here, subject to your permission settings\. Folder settings can run code automatically, even without a model request\. Continue only if you trust these files\. Your trust decision will be saved\.$/;
