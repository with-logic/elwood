/**
 * Parses rendered adapter model picker rows into typed options, and recognizes a
 * model dialog only as the bottom-most native region of the viewport.
 * Implements PRD §5.3 AgentModelOption, C-API-23, and C-API-24.
 */

export type AgentModelOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly raw: string;
};

export type ParsedModelPicker = {
  readonly options: readonly AgentModelOption[];
  readonly cursorIndex: number;
};

export const claudeModelPickerHeader = /Select model/;
export const codexModelPickerHeader = /Select Model and Effort/;

const rowPattern = /^\s*(❯|›)?\s*\d+\.\s+(.+?)\s{2,}(\S.*?)\s*$/;

export function parseClaudeModelPicker(text: string): ParsedModelPicker {
  return parseRows(pickerRegion(text, claudeModelPickerHeader), (labelText) => {
    const isCurrent = labelText.includes("✔");
    const isDefault = /\(recommended\)/i.test(labelText);
    const label = labelText
      .replace("✔", "")
      .replace(/\(recommended\)/i, "")
      .trim();
    return { label, id: label.toLowerCase(), isCurrent, isDefault };
  });
}

export function parseCodexModelPicker(text: string): ParsedModelPicker {
  const parsed = parseRows(pickerRegion(text, codexModelPickerHeader), (labelText) => {
    const isCurrent = /\(current\)/i.test(labelText);
    const isDefault = /\(default\)/i.test(labelText);
    const label = labelText.replace(/\((?:current|default)\)/gi, "").trim();
    return { label, id: label.toLowerCase(), isCurrent, isDefault };
  });
  // Codex omits the default marker when the current model is the default.
  if (parsed.options.some((option) => option.isDefault)) return parsed;
  const options = parsed.options.map((option) =>
    option.isCurrent ? { ...option, isDefault: true } : option,
  );
  return { options, cursorIndex: parsed.cursorIndex };
}

type RowFlags = Pick<AgentModelOption, "id" | "label" | "isCurrent" | "isDefault">;

function parseRows(region: string, decorate: (labelText: string) => RowFlags): ParsedModelPicker {
  const options: AgentModelOption[] = [];
  let cursorIndex = -1;
  for (const line of region.split("\n")) {
    const match = rowPattern.exec(line);
    if (!match) continue;
    if (match[1]) cursorIndex = options.length;
    options.push({
      ...decorate(match[2] as string),
      description: match[3] as string,
      raw: line.trim(),
    });
  }
  return { options, cursorIndex };
}

/** The picker itself, or the stage an accepted row opens (reasoning level, cache warning). */
export type ModelDialogStage = "picker" | "follow-up";

// An agent reply or the composer renders below any header the transcript merely quotes.
const replyRow = /^\s*[●•⏺]/;
const caretRow = /^\s*[❯›]/;
const numberedRow = /^\s*[❯›]?\s*(\d+)[.)]\s/;
// Both CLIs separate the transcript from the composer or a lower dialog with one of these.
const blockEnd = /^\s*(?:[─━]{3}.*)?$/;

/**
 * Whether `lines` (the header row down to the end of the viewport) hold one native
 * dialog and nothing else: no reply row, and every caret or numbered row belongs to a
 * single contiguous block of picker rows numbered from 1 with at most one cursor.
 * A staged composer line, a permission or approval option, or a second numbered list
 * is on a caret row outside that block, restarts the numbering, follows a blank or
 * rule, or lacks the description column, so none of them can pass for the dialog.
 */
function isNativeRegion(lines: readonly string[]): boolean {
  let next = 1;
  let cursors = 0;
  let closed = false;
  for (const line of lines) {
    const number = numberedRow.exec(line)?.[1];
    if (number === undefined) {
      if (replyRow.test(line) || caretRow.test(line)) return false;
      closed ||= next > 1 && blockEnd.test(line);
      continue;
    }
    if (closed || Number(number) !== next || !rowPattern.test(line)) return false;
    next += 1;
    if (caretRow.test(line)) cursors += 1;
  }
  return cursors <= 1;
}

/**
 * The row of the last `header` when it opens the bottom-most native region, else -1.
 * Both CLIs replace the composer with the dialog, so a header with anything foreign at
 * or below it is transcript, composer, or another dialog's content. Elwood must neither
 * cancel such text (Escape would interrupt a running turn, clear staged input, or
 * dismiss a human's prompt) nor hold input on it (C-API-24).
 */
export function bottomDialogRow(text: string, header: RegExp): number {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  return isNativeRegion(lines.slice(Math.max(start, 0))) ? start : -1;
}

function pickerRegion(text: string, header: RegExp): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (header.test(lines[index] as string)) return lines.slice(index).join("\n");
  }
  return "";
}
