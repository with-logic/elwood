/** Await correlated Claude completion despite an earlier composer redraw (PRD §4). */
import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { QuestionActivityEvent } from "../../../src/core/questions/activity.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { SessionQuestions } from "../../../src/core/questions/controller.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import type { ElwoodCommonEventMap } from "../../../src/core/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

type Events = Omit<ElwoodCommonEventMap, "activity"> & {
  activity: ElwoodActivityEvent | QuestionActivityEvent;
  question: ElwoodQuestionEvent;
};
async function submit(order: "composer-first" | "hook-first" | "aborted") {
  const events = new TypedEmitter<Events>();
  const closing = new AbortController();
  const caller = new AbortController();
  const observed: ElwoodQuestionEvent[] = [];
  events.on("question", (event) => observed.push(event));
  const logging = fixture("features-logging");
  const metrics = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const other = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  const successors = [
    fixture("color-blue-highlight"),
    fixture("features-initial"),
    logging,
    metrics,
    fixture("features-both"),
    other,
    fixture("features-submit-highlight"),
    fixture("review"),
    composer(),
  ];
  let writes = 0;
  let finalDone = () => {};
  const final = new Promise<void>((resolve) => {
    finalDone = resolve;
  });
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, () => {
    const next = successors[writes++];
    if (!next) throw new Error("Unexpected extra answer write");
    if (writes === 9 && order === "hook-first") events.emit("activity", nativeHook("PostToolUse"));
    const rendered = render(next);
    if (writes === 9) void rendered.then(finalDone);
  });
  function render(current: QuestionFrame) {
    return terminal.writeOutput(
      `\x1b[H\x1b[2J${current.lines.join("\r\n")}\x1b[${current.cursorRow + 1};${current.cursorX + 1}H\x1b[?25h`,
    );
  }
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
    events.emit("activity", nativeHook());
    await render(fixture("questions"));
    const request = questions.list()[0]!;
    const answers = [
      { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[1]!.id] },
      {
        questionId: request.questions[1]!.id,
        optionIds: request.questions[1]!.options.map((option) => option.id),
      },
    ];
    const pending = questions
      .answer(request.id, answers, { timeoutMs: 3000, signal: caller.signal })
      .then(
        () => "resolved",
        (error: { code: string }) => error.code,
      );
    await final;
    const beforeHook = questions.list();
    if (order === "aborted") caller.abort();
    if (order !== "hook-first") events.emit("activity", nativeHook("PostToolUse"));
    return { result: await pending, writes, observed, beforeHook, request };
  } finally {
    closing.abort();
    terminal.dispose();
  }
}

test.each([
  "composer-first",
  "hook-first",
] as const)("C-QUESTION-03 %s preserves successful native acceptance", async (order) => {
  const result = await submit(order);
  expect(result.writes).toBe(9);
  expect(result.result).toBe("resolved");
  expect(result.observed.filter((event) => event.phase === "closed")).toEqual([
    expect.objectContaining({ phase: "closed", reason: "answered", request: result.request }),
  ]);
  if (order === "composer-first") expect(result.beforeHook).toEqual([result.request]);
});

test("C-QUESTION-03 abort after final Enter retains identity for a later native answer", async () => {
  const result = await submit("aborted");
  expect(result.result).toBe("question_answer_failed");
  expect(result.writes).toBe(9);
  expect(result.beforeHook).toEqual([result.request]);
  expect(result.observed.at(-1)).toMatchObject({
    phase: "closed",
    reason: "answered",
    request: result.request,
  });
});

test("C-QUESTION-03 a predecessor review cannot publish an unseen successor", () => {
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
] as const)("C-QUESTION-03 stale native authority after %s rejects before writing", async (state) => {
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
  const writes: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => fixture("questions"),
    wait: async () => fixture("questions"),
    write: (input) => {
      writes.push(input);
      return Promise.resolve();
    },
  };
  await expect(adapter.answer(request, [], io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(writes).toEqual([]);
});

test.each([
  ["PostToolUse", false, "answered"],
  ["PostToolUseFailure", true, "cancelled"],
  ["PermissionDenied", true, "cancelled"],
  ["PostToolUseFailure", false, "unavailable"],
  ["PermissionDenied", false, "unavailable"],
] as const)("C-QUESTION-03 %s interrupt=%s closes with %s", (name, interrupted, reason) => {
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
