/** Retirement needs candidate-correlated native evidence, never retained prose (PRD §4). */
import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

const decline = "⏺ User declined to answer questions";
test("historical decline text cannot retire a live or ambiguously repainted question", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  const live = frame(`${decline}\n${fixture("questions").text}`);
  adapter.render(live);
  const request = requests.list()[0]!;
  expect(request).toBeDefined();
  adapter.render(live);
  expect(requests.get(request.id)).toBe(request);
  adapter.render(frame(`${decline}\nunrecognized native repaint`));
  expect(requests.get(request.id)).toBe(request);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});

test.each([
  "headers and prompts",
  "prompts only",
])("predecessor chrome with different %s cannot arm a successor's retirement", (difference) => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const successorQuestions = nativeQuestions.map((q) => ({
    ...q,
    header: difference === "prompts only" ? q.header : `Next ${q.header}`,
    question: `Next ${q.question}`,
  }));
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_use_id: "successor",
      tool_input: { questions: successorQuestions },
    }),
  );
  adapter.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
  let successor = fixture("questions").text;
  for (const [index, question] of nativeQuestions.entries()) {
    successor = successor.replace(
      `\n${question.question}\n`,
      `\n${successorQuestions[index]!.question}\n`,
    );
    if (difference !== "prompts only")
      successor = successor.replace(
        `☐ ${question.header}`,
        `☐ ${successorQuestions[index]!.header}`,
      );
  }
  adapter.render(frame(successor));
  expect(requests.list()).toHaveLength(1);
  expect(requests.keyFor(requests.list()[0]!.id)).toBe("successor");
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});

test("a partial panel without options cannot arm retirement", () => {
  const adapter = new ClaudeQuestionAdapter(registry());
  adapter.observe(nativeHook());
  const native = fixture("questions").text;
  adapter.render(frame(native.slice(0, native.indexOf("❯ 1. Amber"))));
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
});

test("a later matching tab can establish native clearance authority", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("features-initial"));
  expect(requests.list()).toHaveLength(1);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});

test("predecessor choices cannot retire an unseen successor with equal prompts", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  adapter.observe(nativeHook("PostToolUse"));
  const successorQuestions = nativeQuestions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option, label: `Next ${option.label}` })),
  }));
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_use_id: "successor",
      tool_input: { questions: successorQuestions },
    }),
  );
  adapter.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
  let successor = fixture("questions").text;
  for (const question of nativeQuestions)
    for (const option of question.options)
      successor = successor.replaceAll(option.label, `Next ${option.label}`);
  adapter.render(frame(successor));
  expect(requests.list()).toHaveLength(1);
  expect(requests.keyFor(requests.list()[0]!.id)).toBe("successor");
});

test("predecessor selection mode cannot arm a successor's retirement", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_use_id: "successor",
      tool_input: {
        questions: nativeQuestions.map((question) => ({
          ...question,
          multiSelect: !question.multiSelect,
        })),
      },
    }),
  );
  adapter.render(fixture("questions"));
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
  expect(adapter.observe(nativeHook("PostToolUse", { tool_use_id: "successor" }))).toBe(true);
  expect(adapter.blocksInput()).toBe(false);
});

test("a foreign initial tab cannot arm retirement before matching native UI", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(frame(fixture("questions").text.replace("☐ Color", "☐ Unrelated")));
  expect(requests.list()).toEqual([]);
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(fixture("questions"));
  expect(requests.list()).toHaveLength(1);
});
