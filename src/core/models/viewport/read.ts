/** Shared complete/prefix reads of a native model block; prefixes carry no write authority (C-API-24/55). */
import { ViewportBlock } from "./block.ts";
import { viewportBody } from "./syntax.ts";
import type { ViewportGrammar } from "./types.ts";

export function readViewport(text: string, grammar: ViewportGrammar, prefix = false) {
  const body = viewportBody(text, grammar, prefix);
  if (body === undefined) return undefined;
  const block = new ViewportBlock(grammar, prefix);
  if (!body.lines.every((line) => block.accept(line))) return undefined;
  const { rows, items, cursorOptionIndex, cursorItemIndex, above, below, tail } = block;
  const selected = items[cursorItemIndex];
  const selectedDisclosureExpanded =
    selected?.kind === "disclosure" ? selected.expanded : undefined;
  const modern =
    above ||
    below ||
    block.nativePartial ||
    items.some((item) => item.kind === "disclosure") ||
    tail.some((line) => grammar.controlRow?.test(line.trim()) === true);
  const first = rows[0];
  const offset =
    !grammar.countedMarkers && above && first !== undefined
      ? first.absoluteRowNumber - 1
      : block.offset;
  const parsed = {
    rows,
    options: rows.map((row) => row.option),
    cursorOptionIndex,
    hiddenRowCountBelow: 0,
  };
  return { parsed, block, footer: body.footer, modern, offset, selectedDisclosureExpanded };
}
