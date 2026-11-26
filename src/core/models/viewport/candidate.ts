/** Holds input on native model prefixes without making them navigable (PRD §5.3, C-API-24/55). */
import { validPositions } from "./positions.ts";
import { readViewport, type ViewportRead, windowVouched } from "./read.ts";
import type { ViewportGrammar } from "./types.ts";

export function isModelViewportCandidate(text: string, grammar: ViewportGrammar): boolean {
  return candidateRead(text, grammar) !== undefined;
}

/**
 * A candidate vouched for as a parsed window is, by two model rows or a counted marker, with
 * its hint row optional: the only unparsed shape failure cleanup Escapes as Elwood's own
 * picker (C-API-55). An unvouched one-row prefix is held, never written to.
 */
export function isVouchedModelViewportCandidate(text: string, grammar: ViewportGrammar): boolean {
  const read = candidateRead(text, grammar);
  return read !== undefined && windowVouched(read, grammar);
}

function candidateRead(text: string, grammar: ViewportGrammar): ViewportRead | undefined {
  const read = readViewport(text, grammar, true);
  if (read === undefined) return undefined;
  const { block, footer, modern, offset, selectedDisclosureExpanded } = read;
  if (!modern) return undefined;
  const { items, tail } = block;
  if (
    !(footer
      ? grammar.validTail(tail, footer, selectedDisclosureExpanded)
      : grammar.prefixTail(tail))
  )
    return undefined;
  return validPositions(items, offset, grammar.agent) ? read : undefined;
}
