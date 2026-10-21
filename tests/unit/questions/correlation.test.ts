/** ID-less Claude completions require matching native definitions (PRD §5.10, C-QUESTION-03). */

import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { definitions, fixture, registry } from "./helpers.ts";

const questions = definitions.map((question) => ({
  question: question.prompt,
  header: question.header!,
  options: question.options,
  multiSelect: question.selection === "multiple",
}));
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
      tool_input: { questions: input },
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
  )(`C-QUESTION-03 unrelated ID-less ${name} cannot retire an active request: %s`, (_label, changed) => {
    const h = setup();
    h.adapter.observe(hook(name, changed));
    expect(h.requests.list()).toEqual([h.request]);
  });
}
