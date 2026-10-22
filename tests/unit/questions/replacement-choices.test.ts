/** Changed native choices cannot inherit a predecessor panel's retirement authority (PRD §4). */
import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

test("a changed-choice replacement stays held through stale panel and composer frames", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  const oldPanel = fixture("questions");
  adapter.observe(nativeHook());
  adapter.render(oldPanel);
  const old = requests.list()[0]!;
  const questions = nativeQuestions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option, label: `New ${option.label}` })),
  })) satisfies AskUserQuestionInput["questions"];
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_input: { questions } satisfies AskUserQuestionInput,
    }),
  );
  expect(requests.get(old.id)).toBeUndefined();
  adapter.render(oldPanel);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(
    frame(oldPanel.text.replace("1. Amber", "1. New Amber").replace("2. Blue", "2. New Blue")),
  );
  expect(requests.list()).toHaveLength(1);
  expect(requests.list()[0]?.id).not.toBe(old.id);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});
