/** Claude final submission and native completion ownership (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { disposeTerminals, controllerHarness as setup } from "./controller-helpers.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

afterEach(disposeTerminals);

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

test("a single final Enter stays pending until its native completion", async () => {
  const observed: ElwoodQuestionEvent[] = [];
  const finalRender = Promise.withResolvers<void>();
  const h = setup(undefined, undefined, () => {
    const current = composer();
    void h.terminal
      .writeOutput(
        `\x1b[H\x1b[2J${current.lines.join("\r\n")}\x1b[${current.cursorRow + 1};3H\x1b[?25h`,
      )
      .then(finalRender.resolve, finalRender.reject);
  });
  const { events, terminal, questions } = h;
  const writeContents = h.writes;
  events.on("question", (event) => observed.push(event));
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
    await Promise.race([
      finalRender.promise,
      pending.then((result) => {
        if (result === "failed") throw new Error("Native answer failed before its final render");
        return finalRender.promise;
      }),
    ]);
    expect(writeContents).toEqual(["\r"]);
    expect(questions.list()).toEqual([request]);
    expect(finished).toBe(false);
    events.emit("activity", hook("PostToolUse"));
    await expect(pending).resolves.toBe("resolved");
    expect(observed.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request });
  } finally {
    h.closing.abort();
  }
});

test("a rejected final write cannot latch submission ownership", async () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook());
  const current = fixture("freeform-questions");
  adapter.render(current);
  const request = requests.list()[0]!;
  const writeContents: string[] = [];
  await expect(
    adapter.answer(request, [{ optionIndexes: [0] }], {
      signal: new AbortController().signal,
      frame: () => current,
      wait: async () => current,
      write: (input, matches) => {
        expect(matches(current)).toBe(true);
        writeContents.push(input);
        return Promise.reject(questionAnswerFailed());
      },
    }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writeContents).toEqual(["\r"]);
  expect(requests.list()).toEqual([request]);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});

test.each([
  ["PostToolUse", false, "answered"],
  ["PostToolUseFailure", true, "cancelled"],
  ["PermissionDenied", true, "cancelled"],
  ["PostToolUseFailure", false, "unavailable"],
  ["PermissionDenied", false, "unavailable"],
] as const)("%s interrupt=%s closes with %s", (name, interrupted, reason) => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  const closed: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => {
    if (event.phase === "closed") closed.push(event);
  });
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const request = requests.list()[0]!;
  adapter.observe(nativeHook(name, { is_interrupt: interrupted }));
  expect(closed).toEqual([expect.objectContaining({ phase: "closed", request, reason })]);
  expect(requests.list()).toEqual([]);
});

test("a predecessor review cannot publish an unseen successor", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_use_id: "next",
      tool_input: {
        questions: nativeQuestions.map((question) => ({
          ...question,
          question: `Next ${question.question}`,
        })),
      },
    }),
  );
  adapter.render(fixture("review"));
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(
    frame(fixture("questions").text.replaceAll("Which test color?", "Next Which test color?")),
  );
  expect(requests.list()).toHaveLength(1);
  expect(requests.list()[0]?.questions[0]?.prompt).toBe("Next Which test color?");
});

test.each([
  "completed",
  "replaced",
] as const)("stale native authority after %s rejects before writing", async (state) => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const request = requests.list()[0]!;
  adapter.observe(
    state === "completed"
      ? nativeHook("PostToolUse")
      : nativeHook("PreToolUse", { tool_use_id: "next" }),
  );
  const writeContents: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => fixture("questions"),
    wait: async () => fixture("questions"),
    write: (input) => {
      writeContents.push(input);
      return Promise.resolve();
    },
  };
  await expect(adapter.answer(request, [], io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(writeContents).toEqual([]);
});
