/** Pinned version, synthetic markers and operation budgets for C-E2E-18 (PRD §12). */
export const claudeQuestionVersion = "2.1.332";
export const claudeQuestionLabel = `Claude Code ${claudeQuestionVersion}`;
/**
 * Embedders name every agent. A named session insets this label in the composer's top rule, and in a
 * border under the footer while a questionnaire is open.
 */
export const claudeQuestionSessionName = "Question Asker";
export const groupedFinal = "ELWOOD_GROUP_DONE";
export const textFinal = "ELWOOD_TEXT_DONE";
export const checkboxFinal = "ELWOOD_FRUIT_DONE";
export const longTextFinal = "ELWOOD_LONG_TEXT_DONE";
export const noteFirstLine = "ELWOOD_NOTE_LINE1";
export const noteLastLine = "ELWOOD_NOTE_LINE2";
const summaryWords = Array.from({ length: 60 }, (_, index) => `w${index}`).join(" ");

/**
 * Answer texts holding a per-run marker. The summary's first line wraps at 140 columns and carries a
 * tab, then a CRLF and a second line; Elwood pastes the CRLF as LF, and Claude must report LF. The
 * link has no spaces, so Claude's editor and review break it inside.
 */
export function claudeProofTexts(marker: string) {
  const summary = `ELWOOD_SUMMARY_${marker} ${summaryWords} ${summaryWords}\tTABBED\r\nELWOOD_SUMMARY_END`;
  const link = `https://example.com/ELWOOD_LINK_${marker}/${"a".repeat(240)}`;
  return { note: `${noteFirstLine}_${marker}\n${noteLastLine}`, summary, link };
}

// Readiness precedes the model turns and has its own startup/rendering budget.
export const claudeReadyTimeoutMs = 45_000;
// Each original send remains bounded while its native answer is collected and submitted.
export const claudeTurnTimeoutMs = 90_000;
// Sandbox setup, the notice posts (3 s each at most) and session teardown have no budgets of their
// own. Whole proofs took 26 to 30 s under load averages near 300, so this leaves them ample room.
export const claudeProofReserveMs = 45_000;
/** Each session's ceiling covers readiness and its turns, plus setup, notices and teardown. */
export const claudeProofTimeoutMs = (turns: number) =>
  claudeReadyTimeoutMs + turns * claudeTurnTimeoutMs + claudeProofReserveMs;
// Native navigation and acknowledgment use the shorter budget inside the turn deadline.
export const claudeAnswerTimeoutMs = 30_000;

export const groupedPrompt = `Call AskUserQuestion exactly once now with two questions, in this order: "Which test features?", header Features, options Logging (description Logs) and Metrics (description Counts), multiSelect true; "Which test color?", header Color, options Amber (description Warm) and Blue (description Cool), single select. After answers, reply exactly ${groupedFinal}. Do not inspect files or use any other tool. These are synthetic preferences that only the user can answer.`;
export const textPrompt = `Call AskUserQuestion exactly once now: "Which test note?", header Note, options Brief (description Short) and Detailed (description Long), single select. After the user answers, reply exactly ${textFinal}. Do not inspect files or use any other tool.`;
export const longTextPrompt = `Call AskUserQuestion exactly once now with two questions, in this order: "Which test summary?", header Summary, options Short (description Brief) and Full (description Complete), single select; "Which test link?", header Link, options Docs (description Manual) and Home (description Site), single select. After answers, reply exactly ${longTextFinal}. Do not inspect files or use any other tool. These are synthetic preferences that only the user can answer.`;
export const checkboxPrompt = `Call AskUserQuestion exactly once now with one question: "Which test fruits?", header Fruits, options Apple (description Red), Banana (description Yellow) and Cherry (description Dark), multiSelect true. After the user answers, reply exactly ${checkboxFinal}. Do not inspect files or use any other tool. These are synthetic preferences that only the user can answer.`;
