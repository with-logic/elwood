/**
 * Parses rendered adapter model picker rows into typed options.
 * Implements PRD §5.3 AgentModelOption and C-API-23.
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

/**
 * The picker itself, the stage an accepted row opens (reasoning level, cache warning),
 * or a dialog shell still `painting`: it holds input but is never sent a key.
 */
export type ModelDialogStage = "picker" | "follow-up" | "painting";

// An agent reply or the composer renders below any header the transcript merely quotes.
const replyRow = /^\s*[●•⏺]/;
const caretRow = /^\s*[❯›]/;

/**
 * A row no native model dialog contains: a reply row, or a caret row that is not a
 * picker row. Picker rows carry a description column, which a permission or approval
 * option (`❯ 1. Yes`) and a numbered composer line lack, so neither can pass for one.
 * `ownRow` admits a dialog's own caret rows that are not picker rows (switch options).
 */
function isForeignRow(line: string, ownRow?: RegExp): boolean {
  if (replyRow.test(line)) return true;
  return caretRow.test(line) && !rowPattern.test(line) && ownRow?.test(line) !== true;
}

/**
 * The row of the last `header` when it opens the bottom-most viewport region, else -1.
 * Both CLIs replace the composer with the dialog, so a header with a foreign row below
 * it is transcript content, and a header ON a foreign row is composer or reply text.
 * Elwood must neither cancel such text (Escape would interrupt a running turn or clear
 * staged input) nor hold input on it (C-API-24).
 */
export function bottomDialogRow(text: string, header: RegExp, ownRow?: RegExp): number {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  return lines.slice(Math.max(start, 0)).some((line) => isForeignRow(line, ownRow)) ? -1 : start;
}

function pickerRegion(text: string, header: RegExp): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (header.test(lines[index] as string)) return lines.slice(index).join("\n");
  }
  return "";
}
