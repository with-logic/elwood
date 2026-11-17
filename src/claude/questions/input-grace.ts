/** Wait for Claude's painted question editor to accept input (PRD §5.10, C-QUESTION-03). */
import { untilQuestionAbort } from "../../core/questions/abort.ts";

// Claude Code 2.1.325 can cancel a just-painted question if its first key arrives
// before the dialog's input handler settles; embedders measured 1.2–1.5 seconds.
export const claudeQuestionInputGraceMs = 1_500;

export async function waitForClaudeQuestionInput(
  inputReadyAt: number,
  signal: AbortSignal,
): Promise<void> {
  const remainingMs = inputReadyAt - performance.now();
  if (remainingMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await untilQuestionAbort(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
