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

export const rowPattern = /^\s*(❯|›)?\s*\d+\.\s+(.+?)\s{2,}(\S.*?)\s*$/;

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

export { bottomDialogCandidate, bottomDialogRow } from "./dialog-region.ts";

/**
 * The picker itself, the stage an accepted row opens (reasoning level, cache warning),
 * or a dialog shell still `painting`: it holds input but is never sent a key.
 */
export type ModelDialogStage = "picker" | "follow-up" | "painting";

/**
 * Proof that ELWOOD opened the dialog this text is being read for, and the thing that
 * grants a rendered region authority over input.
 *
 * Recognition is a grammar over UNTRUSTED bytes: the agent can print anything, including a
 * verbatim picker. No pattern can prove a region is native — each rule only rules out the
 * spoof someone already thought of, which is why successive review rounds kept finding a
 * new string (same-line conversation text, double-spaced staged input, unmarked numbered
 * prompts, a column-zero warning, content after the footer, a numbered composer draft).
 *
 * Provenance inverts the burden. A region may be treated as a live dialog ONLY while a
 * `listModels`/`setModel` transaction Elwood itself started is in flight — it wrote
 * `/model` and is waiting on the result — or while cleanup is tracking a dialog that
 * transaction left behind. Every other frame is out of scope by construction, whatever it
 * renders. The grammar then only has to tell Elwood's OWN dialog apart from the rest of
 * its own screen, which is a bounded problem, rather than adjudicate arbitrary text.
 * Implements C-API-24.
 */
/**
 * The authority an adapter spec uses when revalidating its OWN dialog immediately before a
 * write. These calls only ever run inside a transaction Elwood opened, so they carry it;
 * it is a shared named constant so a call site outside a transaction has to reach for it
 * deliberately rather than inline `{ opened: true }`.
 */
export const ownOperation: ModelDialogAuthority = { opened: true };

export type ModelDialogAuthority = {
  /**
   * True only inside a transaction Elwood opened, after its `/model` write. Callers cannot
   * synthesize this from screen text: it comes from the transaction's own state.
   */
  readonly opened: boolean;
};

function pickerRegion(text: string, header: RegExp): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (header.test(lines[index] as string)) return lines.slice(index).join("\n");
  }
  return "";
}
