/**
 * Binds trust headers and options to one active terminal dialog.
 * Implements PRD §5.4 and C-TRUST-01; blank/wrapped explanatory rows stay in the dialog.
 */
import { nonOptionText, type SelectableOption, selectableOptions } from "../terminal-options.ts";

const headerStart =
  /^(?:Do you|Quick safety|Is this|Load this|Trust the|New MCP|WARNING:|Claude Code|Hooks need)/i;
const numberedRow = /^\s*[❯›>]?\s*\d+[.)]\s*\S/;
const footerRow =
  /^\s*(?:Enter to confirm|Esc to cancel)(?:\s*[·•]\s*(?:Enter to confirm|Esc to cancel))*\s*$/i;
const transcriptRow = /^\s*(?:[●•│╭╰]|[─━]{3}|[❯›]\s*$)/;
const foreignTitle =
  /^\s*(?:Bash command|PowerShell command|Edit file|Write file|Permission request)\s*$/i;

type TrustDialog = {
  readonly options: readonly SelectableOption[];
};

/** Finds the last standalone matching header whose entire tail is one dialog. */
export function trustDialog(frame: string, headerPattern: RegExp): TrustDialog | undefined {
  const lines = frame.split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!headerStart.test(lines[start]!.trim())) continue;
    const tail = lines.slice(start);
    const text = tail.join("\n");
    const header = nonOptionText(text).trim();
    const match = headerPattern.exec(header);
    if (match === null) continue;
    // An indented continuation of an earlier numbered option is still option
    // text. A fresh dialog after a completed option block needs a separating row.
    const previous = lines.slice(0, start);
    const priorOption = previous.findLastIndex((line) => numberedRow.test(line));
    if (priorOption >= 0 && !previous.slice(priorOption + 1).some(isSeparator)) continue;
    const remainingHeader = header.slice(match[0].length).replace(/^\s*\?/, "");
    // Another question/title cannot inherit an earlier trust header's authority.
    if (remainingHeader.includes("?") || tail.some((line) => foreignTitle.test(line))) continue;
    const options = selectableOptions(text);
    const headerLength = nonOptionText(text).length;
    let offset = 0;
    const optionStart = tail.findIndex((line) => {
      const afterHeader = offset > headerLength;
      offset += line.length + 1;
      return afterHeader;
    });
    const headerRows = optionStart < 0 ? tail : tail.slice(0, optionStart);
    if (headerRows.some((line) => transcriptRow.test(line))) continue;
    if (optionStart >= 0 && !validOptionTail(tail.slice(optionStart), options)) continue;
    return { options };
  }
  return undefined;
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
