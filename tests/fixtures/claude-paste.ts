/**
 * Claude Code 2.1.332's standalone `<pasted_content>` envelope around one composer paste, as its
 * submit hook delivers it (PRD §5.4, C-API-67; `docs/cli-behavior.md`, "Claude native paste
 * presentation"). `id` is the first four hex digits of the SHA-256 of the native session id.
 */
export function claudePasteEnvelope(body: string, id: string): string {
  return `\n\n<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;
}

/** Matches one whole standalone envelope; the first group is its id. */
export const claudePasteEnvelopePattern =
  /^\n\n<pasted_content id="([0-9a-f]{4})">\n[\s\S]*\n<\/pasted_content id="\1">\n$/u;
