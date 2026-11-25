/** Compare Claude composer text for native acceptance and API attribution (C-CLAUDE-25 and C-API-71). */
const fullwidthLessThan = String.fromCodePoint(0xff1c);
const tabExpansion = "    ";

/**
 * Normalize newlines, trailing whitespace and the two forms of Claude's tag escapes.
 * Literal and Claude-inserted `<\\` can produce the same echo, so this form is for comparison.
 * Expand remaining tabs after trimming. The bounded form checks UTF-16 size before expansion.
 */
export function normalizeClaudePastedPayload(text: string): string;
export function normalizeClaudePastedPayload(
  text: string,
  maxNormalizedCodeUnits: number,
): string | undefined;
export function normalizeClaudePastedPayload(
  text: string,
  maxNormalizedCodeUnits?: number,
): string | undefined {
  if (
    maxNormalizedCodeUnits !== undefined &&
    text.length > tabExpansion.length * maxNormalizedCodeUnits
  )
    return undefined;
  const base = text
    .replace(/\r\n?/gu, "\n")
    .replaceAll(fullwidthLessThan, "<")
    .replaceAll("<\\", "<")
    .trimEnd();
  if (maxNormalizedCodeUnits !== undefined) {
    let length = base.length;
    if (length > maxNormalizedCodeUnits) return undefined;
    for (let tab = base.indexOf("\t"); tab >= 0; tab = base.indexOf("\t", tab + 1)) {
      length += tabExpansion.length - 1;
      if (length > maxNormalizedCodeUnits) return undefined;
    }
  }
  return base.replaceAll("\t", tabExpansion);
}
