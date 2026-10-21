/** Controller answer ownership and cancellation wiring (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { disposeTerminals, controllerHarness as setup } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeTerminals);
test("accepted requests hold ordinary input until the asynchronous adapter finishes", async () => {
  const h = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.questions.configure((registry) => ({
    ...h.adapter,
    blocksInput: () => false,
    answer: async (request) => {
      registry.close(request.id, "answered");
      entered.resolve();
      await release.promise;
    },
  }));
  const request = h.questions.registry.publish("one", "blocking", definitions.slice(0, 1))!;
  await h.terminal.writeOutput("native question");
  const pending = h.questions.answer(request.id, [
    { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
  ]);
  try {
    await entered.promise;
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.blocksInput()).toBe(true);
    release.resolve();
    await pending;
    expect(h.questions.blocksInput()).toBe(false);
  } finally {
    release.resolve();
    await pending;
    h.closing.abort();
  }
});

test.each([
  "caller input",
  "answer options",
] as const)("%s cancellation reaches the adapter through SessionQuestions.answer", async (source) => {
  const h = setup();
  const options = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.questions.configure((registry) => ({
    ...h.adapter,
    answer: async (request, _answers, io) => {
      await io.write("initial", () => true);
      entered.resolve();
      await release.promise;
      await io.write("late", () => true);
      registry.close(request.id, "answered");
    },
  }));
  const request = h.questions.registry.publish("one", "blocking", definitions.slice(0, 1))!;
  await h.terminal.writeOutput("native question");
  const pending = h.questions.answer(
    request.id,
    [{ questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] }],
    source === "answer options" ? { signal: options.signal } : undefined,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  try {
    await entered.promise;
    expect(h.writes).toEqual(["initial"]);
    (source === "caller input" ? h.input : options).abort();
    release.resolve();
    await rejected;
    expect(h.writes).toEqual(["initial"]);
    expect(h.questions.list()).toEqual([]);
    expect(h.questions.registry.find("one")).toBe(request);
    expect(h.questions.registry.hasPending()).toBe(true);
  } finally {
    release.resolve();
    h.closing.abort();
    await pending.catch(() => {});
  }
});
