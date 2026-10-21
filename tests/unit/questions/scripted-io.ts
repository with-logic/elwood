/** Fixed native frame sequences for private Claude answer tests (PRD §4). */
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";

export function scriptedQuestionIo(initial: QuestionFrame, successors: readonly QuestionFrame[]) {
  let current: QuestionFrame | undefined = initial;
  const writes: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    wait: (predicate) => {
      if (!(current && predicate(current))) throw new Error("Unexpected native wait stage");
      return Promise.resolve(current);
    },
    write: (input, expected) => {
      if (!(current && expected(current))) throw new Error("Native write was not authorized");
      writes.push(input);
      current = successors[writes.length - 1];
      return Promise.resolve();
    },
  };
  return { io, writes };
}
