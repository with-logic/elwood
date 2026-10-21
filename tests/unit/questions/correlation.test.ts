/** ID-less Claude completions require matching native definitions (PRD §4). */

import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { fixture, registry } from "./helpers.ts";
import { nativeHook, nativeQuestions as questions } from "./lifecycle-helpers.ts";

function setup() {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  return { requests, adapter, request: requests.list()[0] };
}
const mismatches: Readonly<Record<string, AskUserQuestionInput["questions"]>> = {
  count: questions.slice(1),
  prompt: questions.map((q) => ({ ...q, question: `Different ${q.question}` })),
  header: questions.map((q) => ({ ...q, header: `Different ${q.header}` })),
  selection: questions.map((q) => ({ ...q, multiSelect: !q.multiSelect })),
  optionCount: questions.map((q) => ({ ...q, options: q.options.slice(1) })),
  optionLabel: questions.map((q) => ({
    ...q,
    options: q.options.map((o) => ({ ...o, label: `Different ${o.label}` })),
  })),
  optionDescription: questions.map((q) => ({
    ...q,
    options: q.options.map((o) => ({ ...o, description: `Different ${o.description}` })),
  })),
  optionOrder: questions.map((q) => ({ ...q, options: q.options.toReversed() })),
};
for (const name of ["PostToolUse", "PostToolUseFailure"]) {
  test.each(
    Object.entries(mismatches),
  )(`unrelated ID-less ${name} cannot retire an active request: %s`, (_label, changed) => {
    const h = setup();
    h.adapter.observe(
      nativeHook(name, {
        tool_input: { questions: changed } satisfies AskUserQuestionInput,
        tool_use_id: undefined,
      }),
    );
    expect(h.requests.list()).toEqual([h.request]);
  });
}

test("omitted multiSelect defaults to single and matches an ID-less completion", () => {
  const input = [
    {
      question: "Which test note?",
      header: "Note",
      options: [
        { label: "Brief (short)", description: "A short test note." },
        { label: "Detailed (long)", description: "A long test note." },
      ],
    },
  ] satisfies AskUserQuestionInput["questions"];
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_input: { questions: input } satisfies AskUserQuestionInput,
      tool_use_id: "single",
    }),
  );
  adapter.render(fixture("freeform-questions"));
  expect(requests.list()[0]?.questions[0]?.selection).toBe("single");
  adapter.observe(
    nativeHook("PostToolUse", {
      tool_input: { questions: input } satisfies AskUserQuestionInput,
      tool_use_id: undefined,
    }),
  );
  expect(requests.list()).toEqual([]);
});
test("equivalent ID-less definitions match regardless of object field order", () => {
  const h = setup();
  const reordered = questions.map((q) => ({
    options: q.options.map((o) => ({
      ...(o.description === undefined ? {} : { description: o.description }),
      label: o.label,
    })),
    ...(q.multiSelect ? { multiSelect: true } : {}),
    header: q.header,
    question: q.question,
  }));
  h.adapter.observe(hook("PostToolUse", reordered));
  expect(h.requests.list()).toEqual([]);
});
test("a completion without an active candidate cannot create authority", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook("PostToolUse", questions));
  expect(requests.list()).toEqual([]);
});
