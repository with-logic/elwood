/**
 * Parses one active terminal dialog before matching the trust allowlist.
 * Implements PRD §5.4 and C-TRUST-01; native copy is validated separately per prompt.
 */
import { nonOptionText, type SelectableOption, selectableOptions } from "../terminal-options.ts";

const headerStart =
  /^(?:Do you|Quick safety|Is this|Load this|Trust the|New MCP|WARNING:|Claude Code running|Hooks need)/i;
const numberedRow = /^\s*[❯›>]?\s*\d+[.)]\s*\S/;
const footerRow =
  /^\s*(?:(?:Enter to confirm|Esc to cancel)(?:\s*[·•]\s*(?:Enter to confirm|Esc to cancel))*|Press enter to (?:continue|confirm or esc to (?:cancel|go back)))\s*$/i;
// Native Codex's location prelude begins with >; conversation/composer rows do too.
const conversationRow =
  /^\s*(?:[●•]|[❯›](?!\s*\d+[.)])|>(?!\s+You are in (?:\/|[A-Z]:[\\/]))(?!\s*\d+[.)])|(?:user|assistant)\s*:)/i;

export type TrustDialog = {
  readonly header: string;
  readonly options: readonly SelectableOption[];
};

/** Parse the last standalone candidate once; never borrow an earlier candidate's options. */
export function parseTrustDialog(frame: string): TrustDialog | undefined {
  const lines = frame.split("\n");
  let start = -1;
  let insideNumberedOption = false;
  for (const [row, line] of lines.entries()) {
    if (numberedRow.test(line)) insideNumberedOption = true;
    else if (isSeparator(line)) insideNumberedOption = false;
    else if (!insideNumberedOption && headerStart.test(line.trim())) start = row;
  }
  if (start < 0) return undefined;
  // Keep the provenance of a candidate when removing its prelude. Exact native
  // copy quoted below a conversation row is still conversation content.
  if (lines.slice(0, start).some((line) => conversationRow.test(line))) return undefined;
  const tail = lines.slice(start);
  const text = tail.join("\n");
  const header = nonOptionText(text);
  const options = selectableOptions(text);
  // nonOptionText joins original rows with a space, preserving their lengths.
  // Replacing each newline by a space therefore gives the same boundary.
  let offset = 0;
  const optionStart = tail.findIndex((line) => {
    const afterHeader = offset > header.length;
    offset += line.length + 1;
    return afterHeader;
  });
  if (optionStart >= 0 && !validOptionTail(tail.slice(optionStart), options)) return undefined;
  return { header: header.trim().replace(/\s+/g, " "), options };
}

function isSeparator(line: string): boolean {
  return line.trim() === "" || footerRow.test(line) || /^[─━]{3}/.test(line.trim());
}

function validOptionTail(lines: readonly string[], options: readonly SelectableOption[]): boolean {
  let footer = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (footerRow.test(line)) {
      footer = true;
      continue;
    }
    if (footer) return false;
    if (numberedRow.test(line)) continue;
    const label = line.trim().replace(/^[❯›]\s+/, "");
    if (!options.some((option) => option.style === "cursor" && option.label === label))
      return false;
  }
  return true;
}
