/** Find Claude's questionnaire footer, which a narrow pane wraps over rows (PRD §5.10, C-QUESTION-03). */

const questionFooter = /^Enter to select · .+ · Esc to cancel$/;
/** At 60 columns Claude 2.1.332 wraps the footer over two rows; allow one more for narrower panes. */
const maxFooterRows = 3;

/** The row the footer ends on, joining rows Claude wrapped it over; -1 when no row ends one. */
export function claudeQuestionFooterEnd(lines: readonly string[]): number {
  return lines.findLastIndex((line, end) => {
    // Claude wraps at spaces, so a wrapped footer's last row still ends with `cancel`. A shorter
    // question can draw that row on a replaced notice's row, which keeps blank cells after it.
    if (!/cancel *$/.test(line)) return false;
    // Claude draws every footer row from column 0, so only trailing cells are dropped.
    let joined = line.trimEnd();
    for (let start = end; start > end - maxFooterRows && start >= 0; start -= 1) {
      if (start < end) joined = `${lines[start]!.trimEnd()} ${joined}`;
      if (questionFooter.test(joined)) return true;
    }
    return false;
  });
}
