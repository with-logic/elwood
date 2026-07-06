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

function pickerRegion(text: string, header: RegExp): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (header.test(lines[index] as string)) return lines.slice(index).join("\n");
  }
  return "";
}
