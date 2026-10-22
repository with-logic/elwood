/** Bind successful private question pastes to stable native editor evidence (PRD §4). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import { draftPosition } from "./draft.ts";
import type { QuestionView } from "./frame.ts";

/**
 * Return a serialized equality receipt for the complete rendered editor rows,
 * cursor provenance, layout and geometry, or undefined when editor evidence is
 * absent or still a placeholder. Comparing receipts detects editor replacement;
 * a receipt alone does not prove the full logical answer or native acceptance.
 */
export function ownedEditorReceipt(
  frame: QuestionFrame,
  view: QuestionView,
  question: QuestionDefinition,
): string | undefined {
  const position = draftPosition(view, question);
  const cursor = view.cursor;
  if (
    !position ||
    cursor.visible !== true ||
    cursor.dimmed !== false ||
    cursor.before === undefined ||
    cursor.row < position.start ||
    cursor.row >= view.rawBody.length
  )
    return undefined;
  const { start, prefix, placeholder } = position;
  const rows = view.rawBody.slice(start);
  if (
    !rows[0]!.startsWith(prefix) ||
    (cursor.row === start &&
      cursor.before === prefix &&
      rows[0]!.trimEnd() === prefix + placeholder)
  )
    return undefined;
  return JSON.stringify([
    frame.cols,
    frame.rows,
    view.kind,
    view.index,
    view.count,
    view.selected,
    view.notes,
    rows,
    cursor,
  ]);
}
