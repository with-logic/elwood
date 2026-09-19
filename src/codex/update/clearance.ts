/**
 * Recognizes when a Codex frame has POSITIVELY returned to idle, which is the only thing
 * that releases a retained input hold. Implements PRD §5.5 and C-CODEX-22.
 *
 * Split from `tracker.ts`: the tracker owns the appearance lifecycle, this file owns the
 * one question "has the screen settled back to a composer?" — a layout question with
 * enough real-CLI detail to be worth isolating and testing on its own.
 */

/**
 * Codex's idle composer row. Real captured frames render it with placeholder text
 * (`› Ask Codex to do anything`) as well as bare (`› `), and a status/hint footer usually
 * follows it, so requiring a BARE caret as the frame's last row matches neither.
 */
const composerRow = /^\s*›(?:\s|$)/;
/**
 * A row that is part of a live dialog rather than the composer: a numbered option, or a
 * cursor-selected row. The composer caret `›` is byte-identical to Codex's option caret,
 * so the two are separated by what FOLLOWS the caret — an option row carries a numbered
 * label, and `❯` is only ever a selection cursor.
 */
const optionRow = /(?:^|[\s›>❯])\d+[.)]\s*\S|^\s*❯\s+\S/;
/**
 * Rows that may sit BELOW the composer on a real idle frame: the status/hint footer
 * (`gpt-6-astra default · /path`, `? for shortcuts`) and blank separators. Anything else
 * below the composer means the frame is not a settled idle screen.
 */
const footerRow = /^\s*(?:[?⚠]|[\w.-]+\s+\S+\s*·|\S+\s*·\s*\S)/;

/**
 * Whether a frame POSITIVELY shows that no dialog is up any more, which is the only thing
 * that releases a retained input hold.
 *
 * Both naive tests are wrong, in opposite directions (round 3 of #59). "No numbered rows"
 * lets a CURSOR-style human prompt (`❯ Yes, go ahead` / `  No, cancel`) release queued
 * input straight into it, pressing its highlighted action. "Any numbered row blocks" pins
 * the hold open forever on ordinary agent prose that happens to contain `1. First step`.
 *
 * What separates them is POSITION, not shape. Both CLIs replace the composer with a live
 * dialog, so a rendered composer row is proof that nothing below it is awaiting an answer:
 * options ABOVE a live composer are transcript the agent printed, while a dialog owning
 * the screen has no composer under it. So the hold clears exactly when the frame's last
 * meaningful row is the composer — which admits the prose case and still holds for a
 * cursor-only dialog, a numbered dialog, and a half-painted one.
 */
export function frameClearsDialog(frameText: string): boolean {
  const rows = frameText.split("\n").filter((row) => row.trim() !== "");
  // Find the LAST composer row, then require everything below it to be footer text. A
  // dialog owning the screen has no composer under it, so a composer with only footer
  // rows beneath is positive evidence the screen settled back to idle.
  const composerAt = rows.findLastIndex((row) => composerRow.test(row) && !optionRow.test(row));
  if (composerAt < 0) return false;
  const below = rows.slice(composerAt + 1);
  if (!below.every((row) => footerRow.test(row) && !optionRow.test(row))) return false;
  // A BARE caret directly beneath a question is the caret of a dialog still painting its
  // options, not the composer — releasing there presses its highlighted action once the
  // rows arrive. A real idle composer either carries its placeholder text or follows the
  // transcript, never a bare question line (#59 round 4).
  const above = rows[composerAt - 1];
  const bare = rows[composerAt]?.trim() === "›";
  return !(bare && above !== undefined && questionRow.test(above));
}

/** A dialog's question line: prose ending in `?`, which a composer never follows directly. */
const questionRow = /\?\s*$/;
