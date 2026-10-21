/** Fixed native frame sequences for private Claude answer tests (PRD §4). */
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";

export function scriptedQuestionIo(initial: QuestionFrame, successors: readonly QuestionFrame[]) {
  let current: QuestionFrame | undefined = initial;
  let pending = false;
  const writes: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    wait: async (predicate) => {
      await Promise.resolve();
      const rendered = pending ? successors[writes.length - 1] : current;
      if (!(rendered && predicate(rendered))) throw new Error("Unexpected native wait stage");
      current = rendered;
      pending = false;
      return rendered;
    },
    write: (input, expected, onDispatch) => {
      if (pending) throw new Error("Native write preceded the render barrier");
      if (!(current && expected(current))) throw new Error("Native write was not authorized");
      onDispatch?.();
      writes.push(input);
      pending = true;
      return Promise.resolve();
    },
  };
  return { io, writes };
}
