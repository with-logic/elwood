/** Recognize Codex's pending-message block between the working row and a queued panel (PRD §5.10). */
const pendingMessagesHeader =
  "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
// Each pending message starts with `↳` under the header; its later rows are indented four spaces.
const pendingMessageRow = /^(?: {2}↳ | {4})/;

/**
 * Whether the rows between the working row and the queued panel are blank or Codex's block of
 * answers it has not submitted yet. Codex 0.172 draws that block right after a queued answer,
 * until it submits the answer, while the hidden cursor stays parked on the working row above.
 */
export function workingRowToPanel(rows: readonly string[]): boolean {
  const content = rows.filter((row) => row.trim() !== "");
  if (content.length === 0) return true;
  const [header, first, ...rest] = content;
  return (
    header === pendingMessagesHeader &&
    first?.startsWith("  ↳ ") === true &&
    rest.every((row) => pendingMessageRow.test(row))
  );
}
