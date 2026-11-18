/** Constructs one native model row and its ordered projection (PRD §5.3, C-API-23/24). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { AgentModelOption, PickerRow } from "./rows.ts";

/** Cursor, absolute model number, label, and description columns. */
export const rowPattern = /^\s*(❯|›)?\s*(\d+)\.\s+(.+?)\s{2,}(\S.*?)\s*$/;

export function modelRow(
  match: RegExpExecArray,
  line: string,
  agent: ElwoodAgentKind,
  selector: (label: string) => string | null = nativeModelSelector,
): PickerRow {
  const labelText = match[3] as string;
  const claude = agent === "claude";
  const label = claude
    ? labelText
        .replace("✔", "")
        .replace(/\(recommended\)/i, "")
        .trim()
    : labelText.replace(/\((?:current|default)\)/gi, "").trim();
  return {
    absoluteRowNumber: Number(match[2]),
    option: {
      label,
      id: selector(label),
      isCurrent: claude ? labelText.includes("✔") : /\(current\)/i.test(labelText),
      isDefault: (claude ? /\(recommended\)/i : /\(default\)/i).test(labelText),
      description: match[4] as string,
      raw: line.trim(),
    },
  };
}

export function inPickerOrder(seen: ReadonlyMap<number, PickerRow>): AgentModelOption[] {
  return [...seen.values()]
    .sort((left, right) => left.absoluteRowNumber - right.absoluteRowNumber)
    .map((row) => row.option);
}

export function nativeModelSelector(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-");
}
