/** Pure captured Codex question fixtures and scripted terminal IO (PRD §4). */
import { readFileSync } from "node:fs";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";

export function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/codex-0.163.0/questions/${name}`, import.meta.url),
    "utf8",
  );
}
export { records } from "./record-fixtures.ts";
export function frame(text: string): QuestionFrame {
  const lines = text.split("\n");
  const cursorRow = lines.findLastIndex((line) => line.trim().length > 0) + 1;
  return { text, lines, cols: 140, rows: 45, cursorX: 0, cursorY: cursorRow, cursorRow };
}
export function captured(name: string): QuestionFrame {
  return frame(fixture(name));
}
export function event(raw: unknown): ElwoodActivityEvent {
  return {
    agent: "codex",
    elwoodSessionId: "test",
    source: "transcript",
    kind: "other",
    label: "native",
    raw,
  };
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
    write: async (input, expected) => {
      if (!(current && expected(current))) throw new Error("Unsafe native write");
      const transition = transitions[index++];
      if (!transition || transition.input !== input)
        throw new Error(`Unexpected input ${JSON.stringify(input)}`);
      writes.push(input);
      current = transition.next ?? current;
      await Promise.resolve();
    },
  };
  return { io, writes, controller };
}
