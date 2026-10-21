/** Pinned version, synthetic markers and operation budgets for C-E2E-18 (PRD §12). */
export const claudeQuestionVersion = "2.1.305";
export const claudeQuestionLabel = `Claude Code ${claudeQuestionVersion}`;
export const groupedFinal = "ELWOOD_GROUP_DONE";
export const textFinal = "ELWOOD_TEXT_DONE";
export const noteFirstLine = "ELWOOD_NOTE_LINE1";
export const noteLastLine = "ELWOOD_NOTE_LINE2";

// Whole-proof ceiling covers isolated setup, readiness, both turns and teardown.
export const claudeProofTimeoutMs = 240_000;
// Readiness precedes the model turns and has its own startup/rendering budget.
export const claudeReadyTimeoutMs = 45_000;
// Each original send remains bounded while its native answer is collected and submitted.
export const claudeTurnTimeoutMs = 90_000;
// Native navigation and acknowledgment use the shorter budget inside the turn deadline.
export const claudeAnswerTimeoutMs = 30_000;

export const groupedPrompt = `Call AskUserQuestion exactly once now with two questions: "Which test color?", header Color, options Amber (description Warm) and Blue (description Cool), single select; "Which test features?", header Features, options Logging (description Logs) and Metrics (description Counts), multiSelect true. After answers, reply exactly ${groupedFinal}. Do not inspect files or use any other tool. These are synthetic preferences that only the user can answer.`;
export const textPrompt = `Call AskUserQuestion exactly once now: "Which test note?", header Note, options Brief (description Short) and Detailed (description Long), single select. After the user answers, reply exactly ${textFinal}. Do not inspect files or use any other tool.`;
