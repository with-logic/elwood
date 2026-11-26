/**
 * Captured Claude workspace disclosures, replayed at the test's launch path: the load rows Claude
 * 2.1.326 and later add for a folder's project settings files and `.mcp.json`, the hooks
 * warning 2.1.329 and later put before them, and the permissions warning 2.1.332 puts before
 * both (C-ATTN-07, C-CLAUDE-26, C-CLAUDE-29, C-CLAUDE-30).
 */
import { capturedFrame } from "./captured-frames.ts";

export const claudeHooksWarning =
  "⚠ This folder configures hooks that can run commands without asking, declared in .claude/settings.json";
export const claudeHooksSettingsLoad =
  "Trusting this folder loads .claude/settings.json (runs commands).";

/** The 2.1.332 hooks prompt captured unwrapped (120 columns) and wrapped (100), on "No, exit". */
export const claudeHooksPrompt = {
  wide: capturedFrame("claude-2.1.332/trust/workspace-hooks-120"),
  wrapped: capturedFrame("claude-2.1.332/trust/workspace-hooks-100"),
} as const;

/** The same captures for hooks in `.claude/settings.local.json`, and in both settings files. */
export const claudeHooksPromptCaptures = (["local", "both"] as const).flatMap((files) =>
  ([120, 100] as const).map(
    (cols) =>
      [
        `${files} at ${cols} columns`,
        capturedFrame(`claude-2.1.332/trust/workspace-hooks-${files}-${cols}`),
      ] as const,
  ),
);

/** Moves a hooks prompt's caret to "Yes": only its "No, exit" frame was captured. */
export function selectClaudeHooksYes(screen: string): string {
  return screen.replace(" ❯ No, exit\n   Yes", "   No, exit\n ❯ Yes");
}

/** The 2.1.310 capture, or the wrapped 2.1.332 hooks capture with its caret moved for "yes". */
export function claudeWorkspaceTrustScreen(
  cwd: string,
  selected: "yes" | "no" = "no",
  variant: "plain" | "hooks" = "plain",
): string {
  const screen =
    variant === "plain"
      ? capturedFrame(`claude-2.1.310/folder-trust-${selected}`)
      : hooksScreen(selected);
  return atLaunchPath(screen, cwd);
}

function hooksScreen(selected: "yes" | "no"): string {
  const screen = claudeHooksPrompt.wrapped;
  return selected === "no" ? screen : selectClaudeHooksYes(screen);
}

/**
 * Captured prompts with Claude 2.1.332's permissions warning (C-CLAUDE-30), on "No, exit",
 * and what each load row discloses: one rule, three, both settings files, a list cut to
 * `and <k> more`, a truncated rule, the hooks warning after it, a warning naming one of two
 * loaded files, and an `.mcp.json` row.
 */
export const claudePermissionsCaptures = (
  [
    ["claude-2.1.332/trust/workspace-permissions-one-120", "settings"],
    ["claude-2.1.332/trust/workspace-permissions-three-120", "settings"],
    ["claude-2.1.332/trust/workspace-permissions-both-120", "settings"],
    ["claude-2.1.332/trust/workspace-permissions-many-100", "settings"],
    ["claude-2.1.332/trust/workspace-permissions-long-100", "settings"],
    ["claude-2.1.332/trust/workspace-permissions-hooks-120", "hooks"],
    ["claude-2.1.332/trust/workspace-permissions-subset-120", "settings"],
    ["claude-2.1.332/trust/workspace-permissions-mcp-120", "mcp_servers"],
  ] as const
).map(([path, disclosure]) => [path, capturedFrame(path), disclosure] as const);

/**
 * Captured load-row prompts, on "No, exit", and what each row discloses. The 2.1.329 captures
 * match 2.1.332's byte for byte; they are the evidence for the probe's 2.1.329 gate.
 */
export const claudeLoadRowCaptures = [
  ...(
    [
      ["claude-2.1.332/trust/workspace-mcp-120", "mcp_servers"],
      ["claude-2.1.332/trust/workspace-settings-120", "settings"],
      ["claude-2.1.332/trust/workspace-settings-local-mcp-100", "mcp_servers"],
      ["claude-2.1.332/trust/workspace-hooks-mcp-120", "hooks"],
      ["claude-2.1.332/trust/workspace-hooks-plus-local-settings-120", "hooks"],
      ["claude-2.1.332/trust/workspace-hooks-both-mcp-100", "hooks"],
      ["claude-2.1.329/trust/workspace-mcp-120", "mcp_servers"],
      ["claude-2.1.329/trust/workspace-settings-120", "settings"],
    ] as const
  ).map(([path, disclosure]) => [path, capturedFrame(path), disclosure] as const),
  ...claudePermissionsCaptures,
];

/** Claude 2.1.332's prompt for a new project MCP server, on "Continue without using this MCP server". */
export const claudeMcpServerPrompt = capturedFrame("claude-2.1.332/trust/mcp-server-120");
/** The same prompt at 100 columns, its body wrapped at another word. */
export const claudeMcpServerPromptNarrow = capturedFrame("claude-2.1.332/trust/mcp-server-100");

/** A captured frame replayed at `cwd`, the test's launch path. */
export function atLaunchPath(screen: string, cwd: string): string {
  return screen.trimEnd().replace("/tmp/ELWOOD_CAPTURE/project", cwd);
}

/** Claude 2.1.332's prompt for settings that set an environment variable Claude does not consider safe. */
export const claudeSettingsEnvPrompt = capturedFrame(
  "claude-2.1.332/trust/workspace-settings-env-120",
);
