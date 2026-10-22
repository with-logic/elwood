/** Refused final Enter cannot claim native-submission ownership (PRD §4). */
import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

test("a rejected stale final frame retires on composer repaint without native submission", async () => {
  const requests = registry();
  const events: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => events.push(event));
  const adapter = new ClaudeQuestionAdapter(requests);
  const toolInput = {
    questions: [
      {
        question: "Which test note?",
        header: "Note",
        options: [
          { label: "Brief (short)", description: "A short test note." },
          { label: "Detailed (long)", description: "A long test note." },
        ],
      },
    ],
  } satisfies AskUserQuestionInput;
  adapter.observe(nativeHook("PreToolUse", { tool_input: toolInput }));
  const initial = fixture("freeform-questions");
  adapter.render(initial);
  const request = requests.list()[0]!;
  const stale = frame(
    initial.text.replace("❯ 1.", "  1.").replace("  2. Detailed", "❯ 2. Detailed"),
  );
  const delivered: string[] = [];
  let finalFrameChecked = false;
  await expect(
    adapter.answer(request, [{ optionIndexes: [0] }], {
      signal: new AbortController().signal,
      frame: () => initial,
      wait: async () => initial,
      write: (input, acceptsCurrentFrame) => {
        expect(input).toBe("\r");
        finalFrameChecked = true;
        if (!acceptsCurrentFrame(stale)) return Promise.reject(questionAnswerFailed());
        delivered.push(input);
        return Promise.resolve();
      },
    }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(finalFrameChecked).toBe(true);
  expect(delivered).toEqual([]);
  expect(requests.list()).toEqual([request]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
  expect(events).toEqual([
    { elwoodSessionId: "s", agent: "claude", phase: "raised", request },
    { elwoodSessionId: "s", agent: "claude", phase: "closed", request, reason: "unavailable" },
  ]);
});
