/**
 * Codex's native footer beneath the composer: the status footer (which Codex wraps onto
 * continuation rows when it does not fit the terminal) and the shortcuts hint.
 * Implements PRD §5.3/§5.4, C-API-28/C-TRUST-01/C-CODEX-28.
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
const hintFooter =
  /^(?: {2})?(?:← for agents · )?\? for shortcuts(?: +⚠ [1-9]\d* warnings? · f2 to view)?$/;
// Native Codex right-aligns this badge; a wrapped status row that ends full has one space.
const warningsBadge = / +⚠ [1-9]\d* warnings? · f2 to view\s*$/;
// The rest of a wrapped status footer: indented text that is not a caret, bullet or warning row.
const continuation = /^ {2}[^\s›»❯>•⚠]/;
// A badge of another shape or count is not the native one: it is not clearance.
const unknownBadge = /⚠ .*f2 to view\s*$/;
// A row narrower than this was not cut by a terminal: nobody runs Codex in fewer columns.
const narrowestWrap = 80;
const cells = (row: string): number => [...row].length;

/**
 * Codex wraps a status row at a break (a space or a path separator) when the next piece
 * would pass the terminal's width. Rows carry no width here, so the widest row beneath
 * the composer stands in for it (the right-aligned warnings badge reaches the edge when
 * present): a row counts as wrapped only if the next row's first piece could not have
 * fitted beside it. With no row at the edge (no hint row, no badge) the row itself is the
 * widest, so only a row at least `narrowestWrap` wide can count as cut.
 */
function wrapped(row: string, next: string, widest: number): boolean {
  const piece = next.trimStart().split(/(?<=\/)|\s/, 1)[0] as string;
  // One more cell for the space that separates pieces when the break fell at a space.
  return cells(row) >= narrowestWrap && cells(row) + cells(piece) + 1 > widest;
}

/**
 * Classify the rows beneath a composer: every row must be native footer chrome. A
 * continuation row is evidence only directly beneath a status row (or another
 * continuation) that is itself full width, never alone. Returns undefined for foreign rows.
 */
export function codexFooterRows(
  rowsBelow: readonly string[],
): { readonly hasStatus: boolean } | undefined {
  const widest = Math.max(0, ...rowsBelow.map(cells));
  const below = rowsBelow.map((row) => row.replace(warningsBadge, "").trimEnd());
  let hasStatus = false;
  // The status row, or continuation, that the current row would continue.
  let open: string | undefined;
  for (const row of below) {
    // A blank row ends any wrapped footer: a continuation sits directly beneath its row.
    if (row === "") open = undefined;
    else if (statusFooter.test(row)) {
      hasStatus = true;
      open = row;
    } else if (hintFooter.test(row)) open = undefined;
    else if (
      open !== undefined &&
      continuation.test(row) &&
      !unknownBadge.test(row) &&
      wrapped(open, row, widest)
    )
      open = row;
    else return undefined;
  }
  return { hasStatus };
}
