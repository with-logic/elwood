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
    let joined = "";
    for (let start = end; start > end - maxFooterRows && start >= 0; start -= 1) {
      const row = lines[start]!;
      // Claude draws every footer row from column 0; an indented row is question copy.
      if (/^\s/.test(row)) return false;
      joined = start < end ? `${row.trimEnd()} ${joined}` : row.trimEnd();
      if (questionFooter.test(joined)) return true;
    }
    return false;
  });
}
