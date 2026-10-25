/**
 * Parses rendered adapter model picker rows into typed options, and recognizes a
 * model dialog only as the bottom-most native region of the viewport.
 * Implements PRD §5.3 AgentModelOption, C-API-23, and C-API-24.
 */

import { overflowMayFollowRow, type ScrollGrammar, unmarkedRow } from "./row-block.ts";

export type AgentModelOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly raw: string;
};

/**
 * One rendered option row. `absoluteRowNumber` is the row's 1-based position in the WHOLE
 * list, as the CLI numbers it: a scrolled window keeps it, so `↑ 3.` is the third model even
 * as the first row on screen.
 */
export type PickerRow = {
  readonly absoluteRowNumber: number;
  readonly option: AgentModelOption;
};

export type ParsedModelPicker = {
  readonly rows: readonly PickerRow[];
  /** Each row's option, in the same order as `rows`. */
  readonly options: readonly AgentModelOption[];
  /** Index into `rows` and `options` of the highlighted row; -1 while none is painted. */
  readonly cursorOptionIndex: number;
  /**
   * How many rows the window hides below its last rendered row: 0 when the window reaches
   * the end of the list, the overflow line's count when one is drawn, and undefined when
   * the window marks rows hidden below without a positive count, so the length is unknown.
   */
  readonly hiddenRowCountBelow: number | undefined;
};

export const claudeModelPickerHeader = /Select model/;
export const codexModelPickerHeader = /Select Model and Effort/;

/** `1. Label  Description`, capturing the cursor glyph, absolute row number, label and description. */
export const rowPattern = /^\s*(❯|›)?\s*(\d+)\.\s+(.+?)\s{2,}(\S.*?)\s*$/;

/**
 * Claude's rendered rows. Under `scroll`, a row wearing a scroll marker (`↓ 10.`) is an
 * ordinary option; its `raw` keeps the marker as rendered.
 */
export function parseClaudeModelPicker(text: string, scroll?: ScrollGrammar): ParsedModelPicker {
  return parseRows(pickerRegion(text, claudeModelPickerHeader), scroll, (labelText) => {
    const isCurrent = labelText.includes("✔");
    const isDefault = /\(recommended\)/i.test(labelText);
    const label = labelText
      .replace("✔", "")
      .replace(/\(recommended\)/i, "")
      .trim();
    return { label, id: label.toLowerCase(), isCurrent, isDefault };
  });
}

/**
 * Rendered markers only. Codex 0.164 draws `(current)` and never `(default)`, so a lone
 * `(current)` says nothing about the default; the Codex spec marks it from config.toml.
 */
export function parseCodexModelPicker(text: string): ParsedModelPicker {
  return parseRows(pickerRegion(text, codexModelPickerHeader), undefined, (labelText) => {
    const isCurrent = /\(current\)/i.test(labelText);
    const isDefault = /\(default\)/i.test(labelText);
    const label = labelText.replace(/\((?:current|default)\)/gi, "").trim();
    return { label, id: label.toLowerCase(), isCurrent, isDefault };
  });
}

type RowFlags = Pick<AgentModelOption, "id" | "label" | "isCurrent" | "isDefault">;

function parseRows(
  region: string,
  scroll: ScrollGrammar | undefined,
  decorate: (labelText: string) => RowFlags,
): ParsedModelPicker {
  const rows: PickerRow[] = [];
  let cursorOptionIndex = -1;
  let hiddenRowCountBelow: number | undefined = 0;
  // As in the region grammar, a count is read only from the line directly under a row
  // `overflowMayFollowRow` allows; an overflow line anywhere else leaves the length unknown.
  let overflowMayFollow = false;
  for (const line of region.split("\n")) {
    const mayBeOverflow = overflowMayFollow;
    overflowMayFollow = false;
    const overflow = scroll?.overflow.exec(line);
    if (overflow)
      hiddenRowCountBelow = mayBeOverflow ? positiveCount(overflow.groups?.["hidden"]) : undefined;
    const match = rowPattern.exec(unmarkedRow(line, scroll));
    if (!match) continue;
    if (match[1]) cursorOptionIndex = rows.length;
    // A `below` marker says rows are hidden; only the overflow line under it says how many.
    if (scroll?.below.test(line) === true) hiddenRowCountBelow = undefined;
    overflowMayFollow = overflowMayFollowRow(line, scroll);
    rows.push({
      absoluteRowNumber: Number(match[2]),
      option: {
        ...decorate(match[3] as string),
        description: match[4] as string,
        raw: line.trim(),
      },
    });
  }
  return { rows, options: rows.map((row) => row.option), cursorOptionIndex, hiddenRowCountBelow };
}

/** The rendered hidden-row count, returned only when it is a positive, exactly representable integer. */
function positiveCount(text: string | undefined): number | undefined {
  const count = Number(text);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

export { bottomDialogCandidate, bottomDialogRow, type DialogGrammar } from "./dialog-region.ts";
export type { ScrollGrammar } from "./row-block.ts";

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
