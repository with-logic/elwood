/**
 * Codex's native footer beneath the composer: the status footer (which Codex wraps onto
 * continuation rows when it does not fit the terminal) and the shortcuts hint.
 * Implements PRD §5.3/§5.4, C-API-28/C-TRUST-01/C-CODEX-26.
 */

import { type CodexReasoningEffort, codexReasoningEfforts } from "../../core/reasoning-effort.ts";
import { codexServiceTierChoices } from "../../core/speed/types.ts";
import { displayColumns } from "./display-columns.ts";

/**
 * The effort labels of Codex's status footer. Codex shows `default` both when no effort is set
 * and when the effort is `none`, and for every effort before it applies the session's
 * configuration (C-API-28).
 */
const codexFooterEffortLabels = [...codexReasoningEfforts, "default"] as const;
export type CodexFooterEffortLabel = (typeof codexFooterEffortLabels)[number];

/**
 * Whether Codex labels `effort` on its footer once it applies the session's configuration.
 * Codex 0.172 labels every effort but `none`, including one the model does not list, which it
 * shows as the model's default effort (C-API-28).
 */
const codexFooterLabelsEffort = {
  none: false,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  ultra: true,
} as const satisfies Record<CodexReasoningEffort, boolean>;

/** Whether a session that requested `effort` shows a label other than `default` once configured. */
export function codexFooterShowsEffort(effort: CodexReasoningEffort | undefined): boolean {
  return effort !== undefined && codexFooterLabelsEffort[effort];
}

const tierBadges = codexServiceTierChoices
  .filter((tier) => tier !== "default")
  .map((tier) => tier.replace(/^./, (first) => `[${first.toUpperCase()}${first}]`))
  .join("|");
const directory = String.raw` · (?:~?\/|[A-Z]:[\\/])[^\n]*`;
const statusFooter = new RegExp(
  String.raw`^ {2}(?<model>(?:gpt|GPT)-[\w.-]+(?: Terra)? )?(?<effort>${codexFooterEffortLabels.join("|")})(?: (?:${tierBadges}))?(?<directory>${directory})?(?: {2,}Plan mode \(⇧tab to cycle\))?$`,
);

/**
 * The effort label of a status row, or undefined when `row` is not one. An effort-only row
 * needs its directory: a bare effort word cannot prove the row is Codex's status footer.
 */
function statusEffortLabel(row: string): CodexFooterEffortLabel | undefined {
  const groups = statusFooter.exec(row)?.groups ?? {};
  const anchored = groups["model"] !== undefined || groups["directory"] !== undefined;
  return anchored ? codexFooterEffortLabels.find((label) => label === groups["effort"]) : undefined;
}

// Beside a warnings badge that leaves no room, Codex drops `? for shortcuts` from the hint.
const hintFooter = /^(?: {2})?(?:← for agents(?: · \? for shortcuts)?|\? for shortcuts)$/;
// Native Codex right-aligns its warnings badge, and shortens it to `⚠ 3 · f2` when it does not
// fit; a wrapped status row that ends full has one space before it. In Plan mode 0.172 draws
// `Plan mode (⇧tab to cycle)` in front of it, or `Plan mode` (at 60 columns and below, and at
// times when the long form fits).
const trailingBadges =
  / +(?:Plan mode(?: \(⇧tab to cycle\))? · )?⚠ [1-9]\d*(?: warnings? · f2 to view| · f2)\s*$/;
// The rest of a wrapped status footer: indented text that is not a caret, bullet or warning row.
const continuation = /^ {2}[^\s›»❯>•⚠]/;
// A badge of another shape or count is not the native one: it is not clearance.
const unknownBadge = /⚠ .*f2(?: to view)?\s*$/;

/** A terminal of unknown width: no row can be proven cut, so no continuation is evidence. */
export const unknownCols = Number.POSITIVE_INFINITY;

/**
 * Whether the terminal's width cut `row` before the first word of `next`. Codex moves a word
 * to the next row only when it does not fit, and it fills a row to the last column (0.170.0,
 * 30 to 160 columns). So `row` was cut only if that word, after one space, could not have
 * fitted beside it. Codex also breaks inside a word (after `/` or `-`), which leaves a
 * shorter piece; the whole word is the test that every real cut passes, whatever the rule.
 */
function rowWasCut(row: string, next: string, cols: number): boolean {
  const word = next.trim().replace(/\s.*$/, "");
  return displayColumns(row) + 1 + displayColumns(word) > cols;
}

/** Native footer rows beneath a composer, with the effort label of their status row if any. */
export type CodexFooter =
  | { readonly hasStatus: false }
  | { readonly hasStatus: true; readonly effortLabel: CodexFooterEffortLabel };

/**
 * Classify the rows beneath a composer in a terminal `cols` columns wide: every row must
 * be native footer chrome. A continuation row is evidence only directly beneath a status
 * row (or another continuation) that the terminal's width cut, never alone. Returns
 * undefined when a row is not footer chrome.
 */
export function classifyCodexFooter(
  rowsBelow: readonly string[],
  cols: number,
): CodexFooter | undefined {
  const below = rowsBelow.map((row) => row.replace(trailingBadges, "").trimEnd());
  let effortLabel: CodexFooterEffortLabel | undefined;
  // The status row, or continuation, that the current row would continue.
  let open: string | undefined;
  for (const row of below) {
    const rowEffortLabel = statusEffortLabel(row);
    const hasContinuationShape = continuation.test(row) && !unknownBadge.test(row);
    const continuesOpenRow =
      open !== undefined && hasContinuationShape && rowWasCut(open, row, cols);
    if (row === "") {
      // A blank row ends any wrapped footer: a continuation sits directly beneath its row.
      open = undefined;
    } else if (rowEffortLabel !== undefined) {
      effortLabel = rowEffortLabel;
      open = row;
    } else if (hintFooter.test(row)) {
      open = undefined;
    } else if (continuesOpenRow) {
      open = row;
    } else {
      return undefined;
    }
  }
  return effortLabel === undefined ? { hasStatus: false } : { hasStatus: true, effortLabel };
}
