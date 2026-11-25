/** Wait for Claude's painted question editor to accept input (PRD §5.10, C-QUESTION-03). */
import { untilQuestionAbort } from "../../core/questions/abort.ts";

/** Wait until an absolute monotonic timestamp in milliseconds from `performance.now()`. */
export async function waitForClaudeQuestionInput(
  inputReadyAtMs: number,
  signal: AbortSignal,
): Promise<void> {
  const remainingMs = inputReadyAtMs - performance.now();
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
