/** Compare Claude composer text for native acceptance and API attribution (C-CLAUDE-25 and C-API-71). */
const fullwidthLessThan = String.fromCodePoint(0xff1c);
const spacesPerTab = "    ";

/**
 * Normalize newlines, trailing whitespace and the two forms of Claude's tag escapes.
 * Expand remaining tabs after trimming. The bounded form checks UTF-16 size before expansion.
 */
export function normalizeClaudePastedPayload(text: string): string;
export function normalizeClaudePastedPayload(text: string, limit: number): string | undefined;
export function normalizeClaudePastedPayload(text: string, limit?: number): string | undefined {
  if (limit !== undefined && text.length > limit) return undefined;
  const base = text
    .replace(/\r\n?/gu, "\n")
    .replaceAll(fullwidthLessThan, "<")
    .replaceAll("<\\", "<")
    .trimEnd();
  if (limit !== undefined) {
    let length = base.length;
    for (let tab = base.indexOf("\t"); tab >= 0; tab = base.indexOf("\t", tab + 1)) {
      length += spacesPerTab.length - 1;
      if (length > limit) return undefined;
    }
  }
  return base.replaceAll("\t", spacesPerTab);
}
