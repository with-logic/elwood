/**
 * UTF-8 boundary arithmetic shared by every bounded byte reader (probe output,
 * transcript cursors). Implements PRD §5.4 and C-PERF-03: a chunked read never
 * decodes a split multibyte code point into U+FFFD.
 */

/**
 * Returns the length of the longest prefix of `bytes` that ends on a complete
 * UTF-8 code point, dropping at most a 3-byte incomplete trailing sequence.
 */
export function completeUtf8Length(bytes: Buffer): number {
  const end = bytes.length;
  // Scan back over continuation bytes (0b10xxxxxx) to the lead byte.
  let lead = end - 1;
  while (lead >= 0 && (bytes[lead] as number) >= 0x80 && (bytes[lead] as number) < 0xc0) lead--;
  if (lead < 0) return end;
  const leadByte = bytes[lead] as number;
  // ASCII byte is itself complete.
  if (leadByte < 0x80) return end;
  // The scan stopped on a lead byte (>= 0xc0), so it heads a 2-, 3-, or 4-byte
  // sequence. Keep all if that sequence is complete; else drop the partial lead.
  const expected = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : 2;
  return end - lead === expected ? end : lead;
}
