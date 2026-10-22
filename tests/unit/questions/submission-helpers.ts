/** Real-terminal Claude submission sequences and awaited render failures (PRD §4). */
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { SessionQuestions } from "../../../src/core/questions/controller.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { paintQuestionFrame } from "./controller-helpers.ts";
import { nativeHook } from "./lifecycle-helpers.ts";

export function submissionHarness(
  initial: QuestionFrame,
  successors: readonly QuestionFrame[],
  toolInput: AskUserQuestionInput,
) {
  const events = new TypedEmitter<{
    activity: ElwoodActivityEvent | QuestionActivityEvent;
    question: ElwoodQuestionEvent;
  }>();
  const closing = new AbortController();
  const final = Promise.withResolvers<void>();
  const writes: string[] = [];
  const observed: ElwoodQuestionEvent[] = [];
  events.on("question", (event) => observed.push(event));
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) => {
    writes.push(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
    const index = writes.length - 1;
    void paint(successors[index]!).then(() => {
      if (index === successors.length - 1) final.resolve();
    }, final.reject);
  });
  const questions = new SessionQuestions(
    "claude",
    "s",
    events,
    terminal,
    () => new AbortController().signal,
    closing.signal,
  );
  questions.configure((requests) => new ClaudeQuestionAdapter(requests));
  const paint = (current: QuestionFrame) => paintQuestionFrame(terminal, current);
  const hook = (name = "PreToolUse", extra: Readonly<Record<string, unknown>> = {}) =>
    events.emit("activity", nativeHook(name, { tool_input: toolInput, ...extra }));
  return {
    questions,
    terminal,
    writes,
    observed,
    final: final.promise,
    hook,
    start: async () => {
      hook();
      await paint(initial);
    },
    dispose: () => {
      closing.abort();
      terminal.dispose();
    },
  };
}
