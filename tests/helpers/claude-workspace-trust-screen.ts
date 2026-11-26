/**
 * Captured Claude workspace disclosures, replayed at the test's launch path, and the rows
 * Claude 2.1.332 adds for a folder whose settings declare hooks (C-ATTN-07, C-CLAUDE-26).
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
  return screen.trimEnd().replace("/tmp/ELWOOD_CAPTURE/project", cwd);
}

function hooksScreen(selected: "yes" | "no"): string {
  const screen = claudeHooksPrompt.wrapped;
  return selected === "no" ? screen : selectClaudeHooksYes(screen);
}
