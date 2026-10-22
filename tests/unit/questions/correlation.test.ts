/** ID-less Claude completions require matching native definitions (PRD §4). */

import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { fixture, registry } from "./helpers.ts";
import { nativeQuestions as questions } from "./lifecycle-helpers.ts";

function hook(
  name: string,
  input: AskUserQuestionInput["questions"],
  id?: string,
): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s",
    agent: "claude",
    source: "hook",
    kind: "hook",
    label: name,
    raw: {
      hook_event_name: name,
      tool_name: "AskUserQuestion",
      tool_input: { questions: input } satisfies AskUserQuestionInput,
      ...(id === undefined ? {} : { tool_use_id: id }),
    },
  };
}
function setup() {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook("PreToolUse", questions, "native"));
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
    h.adapter.observe(hook(name, changed));
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
  adapter.observe(hook("PreToolUse", input, "single"));
  adapter.render(fixture("freeform-questions"));
  expect(requests.list()[0]?.questions[0]?.selection).toBe("single");
  adapter.observe(hook("PostToolUse", input));
  expect(requests.list()).toEqual([]);
});
