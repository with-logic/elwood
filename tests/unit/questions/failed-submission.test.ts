/** Failed Claude submission releases only observed native authority (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import {
  disposeTerminals,
  paintQuestionFrame,
  controllerHarness as setup,
} from "./controller-helpers.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";

const current = frame(fixture("questions").text.replace(/^←.*$/m, " ☐ Color"));
const hook = (name = "PreToolUse", extra: Readonly<Record<string, unknown>> = {}) =>
  nativeHook(name, { tool_input: { questions: [nativeQuestions[0]] }, ...extra });
afterEach(disposeTerminals);

test("a rejected matched Enter preserves its error and releases the later composer", async () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook());
  adapter.render(current);
  const request = requests.list()[0]!;
  const failure = questionAnswerFailed();
  const writeContents: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    wait: async () => current,
    write: (input, matches) => {
      expect(matches(current)).toBe(true);
      writeContents.push(input);
      return Promise.reject(failure);
    },
  };
  await expect(adapter.answer(request, [{ optionIndexes: [0] }], io)).rejects.toBe(failure);
  expect(writeContents).toEqual(["\r"]);
  expect(requests.list()).toEqual([request]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});

test("an aborted physical Enter cannot rearm its API request before native closure", async () => {
  const entered = Promise.withResolvers<void>();
  const h = setup({ onInput: () => entered.resolve() });
  const caller = new AbortController();
  const observed: ElwoodQuestionEvent[] = [];
  h.events.on("question", (event) => observed.push(event));
  h.questions.configure((requests) => new ClaudeQuestionAdapter(requests));
  try {
    h.events.emit("activity", hook());
    await paintQuestionFrame(h.terminal, current);
    const request = h.questions.list()[0]!;
    const answers = [
      { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
    ];
    const pending = h.questions.answer(request.id, answers, { signal: caller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
    await entered.promise;
    expect(h.writes).toEqual(["\r"]);
    caller.abort();
    await failed;
    expect(h.questions.registry.get(request.id)).toBeUndefined();
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.registry.find("native")).toBe(request);
    expect(h.questions.registry.hasPending()).toBe(true);
    expect(h.questions.blocksInput()).toBe(true);
    await paintQuestionFrame(h.terminal, current);
    h.events.emit("activity", hook());
    expect(h.questions.list()).toEqual([]);
    await expect(h.questions.answer(request.id, answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(h.writes).toEqual(["\r"]);
    await paintQuestionFrame(h.terminal, composer());
    expect(h.questions.registry.find("native")).toBe(request);
    expect(h.questions.registry.hasPending()).toBe(true);
    expect(h.questions.blocksInput()).toBe(true);
    h.events.emit("activity", hook("PostToolUse"));
    expect(h.questions.registry.find("native")).toBeUndefined();
    expect(h.questions.registry.hasPending()).toBe(false);
    await paintQuestionFrame(h.terminal, composer());
    expect(h.questions.blocksInput()).toBe(false);
    expect(observed.filter((event) => event.phase === "closed")).toEqual([
      expect.objectContaining({ request, reason: "unavailable" }),
    ]);
  } finally {
    h.closing.abort();
  }
});

test("a predecessor answer failure cannot release a successor submission", async () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook());
  adapter.render(current);
  const predecessor = requests.list()[0]!;
  const failure = questionAnswerFailed();
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    wait: async () => current,
    write: async (_input, matches) => {
      expect(matches(current)).toBe(true);
      adapter.observe(hook("PostToolUse"));
      adapter.observe(hook("PreToolUse", { tool_use_id: "successor" }));
      adapter.render(current);
      const successor = requests.list()[0]!;
      await adapter.answer(successor, [{ optionIndexes: [0] }], scriptedQuestionIo(current, []).io);
      throw failure;
    },
  };
  await expect(adapter.answer(predecessor, [{ optionIndexes: [0] }], io)).rejects.toBe(failure);
  const successor = requests.list()[0]!;
  adapter.render(composer());
  expect(requests.list()).toEqual([successor]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.observe(hook("PostToolUse", { tool_use_id: "successor" }));
  expect(requests.list()).toEqual([]);
});
