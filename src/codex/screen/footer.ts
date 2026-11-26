/**
 * Codex's native footer beneath the composer: the status footer (which Codex wraps onto
 * continuation rows when it does not fit the terminal) and the shortcuts hint.
 * Implements PRD §5.3/§5.4, C-API-28/C-TRUST-01/C-CODEX-26.
 */

import { codexReasoningEfforts } from "../../core/reasoning-effort.ts";
import { codexServiceTierChoices } from "../../core/speed/types.ts";

const tierBadges = codexServiceTierChoices
  .filter((tier) => tier !== "default")
  .map((tier) => tier.replace(/^./, (first) => `[${first.toUpperCase()}${first}]`))
  .join("|");
const effortWithOptionalTier = `(?:${codexReasoningEfforts.join("|")}|default)(?: (?:${tierBadges}))?`;
const directory = String.raw` · (?:~?\/|[A-Z]:[\\/])[^\n]*`;
// An effort-only footer needs its directory; a bare effort word cannot prove configuration.
const statusFooter = new RegExp(
  String.raw`^ {2}(?:(?:gpt|GPT)-[\w.-]+(?: Terra)? ${effortWithOptionalTier}(?:${directory})?|${effortWithOptionalTier}${directory})(?: {2,}Plan mode \(⇧tab to cycle\))?$`,
);
// Beside a warnings badge that leaves no room, Codex drops `? for shortcuts` from the hint.
const hintFooter = /^(?: {2})?(?:← for agents(?: · \? for shortcuts)?|\? for shortcuts)$/;
// Native Codex right-aligns this badge, and shortens it to `⚠ 3 · f2` when it does not fit;
// a wrapped status row that ends full has one space before it. In Plan mode 0.172 draws
// `Plan mode (⇧tab to cycle)`, or `Plan mode` when that does not fit, in front of it.
const warningsBadge =
  / +(?:Plan mode(?: \(⇧tab to cycle\))? · )?⚠ [1-9]\d*(?: warnings? · f2 to view| · f2)\s*$/;
// The rest of a wrapped status footer: indented text that is not a caret, bullet or warning row.
const continuation = /^ {2}[^\s›»❯>•⚠]/;
// A badge of another shape or count is not the native one: it is not clearance.
const unknownBadge = /⚠ .*f2(?: to view)?\s*$/;
// Code points a terminal draws two columns wide: East Asian wide and fullwidth forms, emoji.
// The ranges approximate the East Asian Width table; a missed range counts one column short.
const wideCodePoint =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/gu;
// Doubling each wide code point makes the code-point count equal the column count.
const displayColumns = (text: string): number => [...text.replace(wideCodePoint, "$&$&")].length;

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

/**
 * Classify the rows beneath a composer in a terminal `cols` columns wide: every row must
 * be native footer chrome. A continuation row is evidence only directly beneath a status
 * row (or another continuation) that the terminal's width cut, never alone. Returns
 * undefined when a row is not footer chrome.
 */
export function classifyCodexFooter(
  rowsBelow: readonly string[],
  cols: number,
): { readonly hasStatus: boolean } | undefined {
  const below = rowsBelow.map((row) => row.replace(warningsBadge, "").trimEnd());
  let hasStatus = false;
  // The status row, or continuation, that the current row would continue.
  let open: string | undefined;
  for (const row of below) {
    const hasContinuationShape = continuation.test(row) && !unknownBadge.test(row);
    const continuesOpenRow =
      open !== undefined && hasContinuationShape && rowWasCut(open, row, cols);
    if (row === "") {
      // A blank row ends any wrapped footer: a continuation sits directly beneath its row.
      open = undefined;
    } else if (statusFooter.test(row)) {
      hasStatus = true;
      open = row;
    } else if (hintFooter.test(row)) {
      open = undefined;
    } else if (continuesOpenRow) {
      open = row;
    } else {
      return undefined;
    }
  }
  return { hasStatus };
}
