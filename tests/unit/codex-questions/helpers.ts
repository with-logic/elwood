/** Pure captured Codex question frames and scripted terminal IO (PRD §4). */

import { payloadOf, questionCall } from "../../../src/codex/questions/records.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { fixture, records } from "./fixtures.ts";
import { nativeTranscriptEvent } from "./native-transcript-event.ts";

export { fixture, records };
export function definitions(name: string) {
  const payload = payloadOf(records(name)[0]);
  if (!payload) throw new Error(`Missing native question payload in ${name}`);
  const call = questionCall(payload);
  if (!call) throw new Error(`Invalid native question request in ${name}`);
  return call.questions.map((question) => question.definition);
}
export function frame(text: string): QuestionFrame {
  const lines = text.split("\n");
  const cursorRow = lines.findLastIndex((line) => line.trim().length > 0) + 1;
  return { text, lines, cols: 140, rows: 45, cursorX: 0, cursorY: cursorRow, cursorRow };
}
export function captured(name: string): QuestionFrame {
  return frame(fixture(name));
}
export function event(raw: unknown) {
  return nativeTranscriptEvent(raw, "test");
}
export function scriptedIo(
  initial: QuestionFrame | undefined,
  transitions: readonly { readonly input: string; readonly next?: QuestionFrame }[],
) {
  let current = initial;
  let index = 0;
  const writes: string[] = [];
  const controller = new AbortController();
  const io: QuestionIo = {
    signal: controller.signal,
    frame: () => current,
    wait: async (test) => {
      if (!(current && test(current)))
        throw new Error("Native fixture did not match expected render");
      return await Promise.resolve(current);
    },
    write: async (input, expected, onDispatch) => {
      if (!(current && expected(current))) throw new Error("Unsafe native write");
      const transition = transitions[index++];
      if (!transition || transition.input !== input)
        throw new Error(`Unexpected input ${JSON.stringify(input)}`);
      onDispatch?.();
      writes.push(input);
      current = transition.next ?? current;
      await Promise.resolve();
    },
  };
  return { io, writes, controller };
}
