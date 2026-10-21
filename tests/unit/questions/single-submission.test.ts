/** Single-question final submission shares native completion ownership (PRD §4). */

import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import { SessionQuestions } from "../../../src/core/questions/controller.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { fixture } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

const toolInput = {
  questions: [
    {
      question: "Which test note?",
      header: "Note",
      multiSelect: false,
      options: [
        { label: "Brief (short)", description: "A short test note." },
        { label: "Detailed (long)", description: "A long test note." },
      ],
    },
  ],
};
const hook = (name = "PreToolUse") => nativeHook(name, { tool_input: toolInput });

test("C-QUESTION-03 a single final Enter stays pending until its native completion", async () => {
  const events = new TypedEmitter<{
    activity: ElwoodActivityEvent | QuestionActivityEvent;
    question: ElwoodQuestionEvent;
  }>();
  const closing = new AbortController();
  const writes: string[] = [];
  const observed: ElwoodQuestionEvent[] = [];
  events.on("question", (event) => observed.push(event));
  let submitted: () => void = () => undefined;
  const final = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) => {
    writes.push(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
    const current = composer();
    void terminal
      .writeOutput(
        `\x1b[H\x1b[2J${current.lines.join("\r\n")}\x1b[${current.cursorRow + 1};3H\x1b[?25h`,
      )
      .then(submitted);
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
  try {
    events.emit("activity", hook());
    const current = fixture("freeform-questions");
    await terminal.writeOutput(
      `\x1b[H\x1b[2J${current.lines.join("\r\n")}\x1b[${current.cursorRow + 1};1H\x1b[?25h`,
    );
    const request = questions.list()[0]!;
    let finished = false;
    const pending = questions
      .answer(request.id, [
        { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
      ])
      .then(
        () => {
          finished = true;
          return "resolved";
        },
        () => {
          finished = true;
          return "failed";
        },
      );
    await final;
    expect(writes).toEqual(["\r"]);
    expect(questions.list()).toEqual([request]);
    expect(finished).toBe(false);
    events.emit("activity", hook("PostToolUse"));
    await expect(pending).resolves.toBe("resolved");
    expect(observed.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request });
  } finally {
    closing.abort();
    terminal.dispose();
  }
});
