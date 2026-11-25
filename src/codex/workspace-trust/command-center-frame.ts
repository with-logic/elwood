/** Recognize Codex's command center as a workspace-trust answer destination (C-ATTN-07). */
import type { TerminalSnapshot } from "../../terminal/headless.ts";

const heading = /^ {2}Agent command center {2}Group: (?:Project|Directory|Status|Model)(?: |$)/;
const filters = /^ {2,}All \d+ {2,}Needs you \d+(?: |$)/;

/** The fixed header and viewport-wide rule identify the native picker across keymaps. */
export function isCodexAgentCommandCenter(frame: TerminalSnapshot): boolean {
  const [title = "", tabs = "", divider = ""] = frame.lines;
  const rule = divider.trimEnd();
  return (
    heading.test(title) &&
    filters.test(tabs) &&
    rule.length === frame.cols - 2 &&
    /^ {2}─+$/.test(rule)
  );
}
