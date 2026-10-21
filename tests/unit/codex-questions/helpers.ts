/** Captured Codex question fixtures and live registry harness (PRD §7A.5). */
import { readFileSync } from "node:fs";
import { CodexQuestionAdapter } from "../../../src/codex/questions/adapter.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import type { ElwoodCommonEventMap } from "../../../src/core/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";

export function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/codex-0.163.0/questions/${name}`, import.meta.url),
    "utf8",
  );
}
export function records(name: string): readonly unknown[] {
  return JSON.parse(fixture(name)) as unknown[];
}
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
export function harness() {
  const events: ElwoodQuestionEvent[] = [];
  const emitter = new TypedEmitter<ElwoodCommonEventMap>();
  emitter.on("question", (question) => events.push(question));
  const registry = new QuestionRegistry("codex", "test", emitter);
  const adapter = new CodexQuestionAdapter(registry);
  const observe = (raw: unknown) => adapter.observe(event(raw));
  return { events, emitter, registry, adapter, observe };
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
