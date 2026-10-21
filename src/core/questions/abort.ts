/** Observe late completion while revocation promptly releases an answer attempt (PRD §4). */
import { questionAnswerFailed } from "./errors.ts";

export function untilQuestionAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(questionAnswerFailed());
    };
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
