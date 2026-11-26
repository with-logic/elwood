/** Parses counted Claude windows and uncounted Codex windows (PRD §5.3, C-API-23/24). */
import type { ParsedModelPicker } from "../rows.ts";
import { validPositions } from "./positions.ts";
import { readViewport } from "./read.ts";
import type { ViewportGrammar } from "./types.ts";

/** Undefined leaves older layouts to the existing attached-marker grammar. */
export function parseModelViewport(
  text: string,
  grammar: ViewportGrammar,
): ParsedModelPicker | undefined {
  const read = readViewport(text, grammar);
  if (read === undefined) return undefined;
  const { parsed, block, footer, modern, offset, selectedDisclosureExpanded } = read;
  const { items, tail, above, below, remainingBelow, cursorItemIndex } = block;
  // A short pane's window can hold one item (a model row, or only the disclosure) or a row
  // beside the disclosure; a counted scroll marker then vouches for the items it hides
  // (Claude 2.1.332 below about 22 rows). Codex's bare arrows count nothing, so never vouch.
  const windowVouched = parsed.rows.length >= 2 || (grammar.countedMarkers && (above || below));
  if (!(windowVouched && grammar.validTail(tail, footer, selectedDisclosureExpanded)))
    return undefined;
  if (!modern) return undefined;
  if (
    (above && offset < 1) ||
    !Number.isSafeInteger(offset + items.length + (remainingBelow ?? 0)) ||
    !validPositions(items, offset, grammar.agent)
  )
    return undefined;
  return { ...parsed, viewport: { items, offset, remainingBelow, cursorItemIndex } };
}
