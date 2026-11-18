/** Native model-window boundaries and control rows (PRD §5.3, C-API-24). */
import { positiveCount } from "../counts.ts";
import { isModelFooter } from "../hints.ts";
import type { ViewportGrammar } from "./types.ts";
export const blankOrRule = /^\s*(?:[─━▔]{3,})?\s*$/;
const foreignRow = /^\s*(?:[❯›»●•⏺↑↓]|\d+[.)]\s)/;

/** Only a closing hint row, followed by blank/rule rows, completes the region. */
export function viewportBody(text: string, grammar: ViewportGrammar, prefix: boolean) {
  const { header, footer: footerPattern } = grammar;
  if (!header.test(text)) return undefined;
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  if (start < 0 || foreignRow.test(lines[start] as string)) return undefined;
  const body = lines.slice(start + 1);
  const footerIndex = body.findIndex((line) => footerPattern.test(line));
  const footer = body[footerIndex];
  if (footer === undefined && prefix) return { lines: body, footer: "" };
  if (
    footer === undefined ||
    !isModelFooter(footer, footerPattern) ||
    body.slice(footerIndex + 1).some((line) => !blankOrRule.test(line))
  )
    return undefined;
  return { lines: body.slice(0, footerIndex), footer };
}

/** A malformed or misplaced marker is never treated as ordinary dialog prose. */
export function viewportMarker(line: string, grammar: ViewportGrammar) {
  const match = grammar.marker.exec(line);
  if (match === null) return undefined;
  const count = grammar.countedMarkers ? positiveCount(match[2]) : undefined;
  if (grammar.countedMarkers && count === undefined) return undefined;
  return { direction: match[1] as "↑" | "↓", count };
}

export function foreignViewportRow(line: string): boolean {
  return foreignRow.test(line);
}

export function viewportTail(lines: readonly string[]): string[] {
  return lines.filter((line) => !blankOrRule.test(line)).map((line) => line.trim());
}
