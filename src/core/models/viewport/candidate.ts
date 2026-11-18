/** Holds input on native model prefixes without making them navigable (PRD §5.3, C-API-24/55). */
import { validPositions } from "./positions.ts";
import { readViewport } from "./read.ts";
import type { ViewportGrammar } from "./types.ts";

export function isModelViewportCandidate(text: string, grammar: ViewportGrammar): boolean {
  const read = readViewport(text, grammar, true);
  if (read === undefined) return false;
  const { block, footer, modern, offset, selectedDisclosureExpanded } = read;
  if (!modern) return false;
  const { items, tail } = block;
  if (
    !(footer
      ? grammar.validTail(tail, footer, selectedDisclosureExpanded)
      : grammar.prefixTail(tail))
  )
    return false;
  return validPositions(items, offset, grammar.agent);
}
