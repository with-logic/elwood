/**
 * Parses one active terminal dialog before matching the trust allowlist.
 * Implements PRD §5.4 and C-TRUST-01; native copy is validated separately per prompt.
 */
import {
  cursorOptionRows,
  nonOptionText,
  type SelectableOption,
  selectableOptions,
} from "../terminal-options.ts";

const headerStart =
  /^(?:Do you|Quick safety|Is this|Load this|Trust the|Trust this|New MCP|WARNING:|Claude Code running|Hooks need)/i;
const numberedRow = /^\s*[❯›>]?\s*\d+[.)]\s*\S/;
const footerRow =
  /^\s*(?:(?:Enter to confirm|Esc to cancel)(?:\s*[·•]\s*(?:Enter to confirm|Esc to cancel))*|Press enter to (?:continue|confirm or esc to (?:cancel|go back))|enter continue · esc quit)\s*$/i;
// Native Codex's location prelude begins with >; conversation/composer rows do too.
const conversationRow =
  /^\s*(?:[●•]|[❯›](?!\s*\d+[.)])|>(?!\s+You are in (?:\/|[A-Z]:[\\/]))(?!\s*\d+[.)])|(?:user|assistant)\s*:)/i;

export type TrustDialog = {
  readonly header: string;
  readonly options: readonly SelectableOption[];
};

/** Parse the last standalone candidate once; never borrow an earlier candidate's options. */
export function parseTrustDialog(frame: string): TrustDialog | undefined {
  const candidate = parseTrustCandidates(frame)[0];
  return candidate?.validTail ? candidate.dialog : undefined;
}

type Candidate = {
  readonly dialog: TrustDialog;
  readonly validTail: boolean;
  /** The frame ends in a native footer row: the dialog finished painting. */
  readonly footer: boolean;
};

/**
 * A provenance-checked header may hold input even while its native body is incomplete.
 * Every standalone header region, bottom-most first. Only the bottom-most can be a
 * safe write target; an earlier one exists so that header-like text BELOW a known
 * gate cannot make the gate disappear from input holding (it fails closed instead).
 */
export function parseTrustCandidates(frame: string): readonly Candidate[] {
  const lines = frame.split("\n");
  const starts: number[] = [];
  // A cursor block's unselected rows carry no caret, so only the parsed bounds can
  // tell them from prose; numbered rows announce themselves and are tracked inline.
  const cursorBlock = cursorOptionRows(lines);
  let insideNumberedOption = false;
  for (const [row, line] of lines.entries()) {
    if (cursorBlock !== undefined && row >= cursorBlock.firstRow && row <= cursorBlock.lastRow)
      continue;
    if (numberedRow.test(line)) insideNumberedOption = true;
    else if (isSeparator(line)) insideNumberedOption = false;
    else if (!insideNumberedOption && headerStart.test(line.trim())) starts.unshift(row);
  }
  return starts.flatMap((start, index) => {
    const candidate = candidateAt(lines, start);
    if (candidate === undefined) return [];
    return [index === 0 ? candidate : { ...candidate, validTail: false }];
  });
}

function candidateAt(lines: readonly string[], start: number): Candidate | undefined {
  // Keep the provenance of a candidate when removing its prelude. Exact native
  // copy quoted below a conversation row is still conversation content.
  if (lines.slice(0, start).some((line) => conversationRow.test(line))) return undefined;
  const tail = lines.slice(start);
  const unknownTail = tail.some((line) => /^\s*(?:[●•]|(?:user|assistant)\s*:)/i.test(line));
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
  return {
    dialog: { header: header.trim().replace(/\s+/g, " "), options },
    validTail:
      !unknownTail && (optionStart < 0 || validOptionTail(tail.slice(optionStart), options)),
    footer: footerRow.test(text.slice(text.trimEnd().lastIndexOf("\n") + 1)),
  };
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
