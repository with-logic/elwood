/** Claude retirement is native-correlated and safe across reentrant observers (PRD §4). */

import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { definitions, fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

const stop = {
  ...nativeHook("Stop"),
  kind: "hook_result" as const,
  hookEventName: "Stop",
  raw: {},
};

test("an unsupported unpublished candidate retires only after native chrome and live composer clearance", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(frame(fixture("questions").text.replace("2. Blue", "2. Violet")));
  expect(requests.list()).toEqual([]);
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(false);
});
test("Stop reports actual candidate, physical hold, and registry retirement once", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  expect(adapter.observe(stop)).toBe(false);
  adapter.render(fixture("questions"));
  expect(adapter.observe(stop)).toBe(true);
  expect(adapter.blocksInput()).toBe(false);
  requests.publish("external", "blocking", definitions);
  expect(adapter.observe(stop)).toBe(true);
  expect(adapter.observe(stop)).toBe(false);
});
test("answer delegation rejects a changed native stage before any write", async () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  const request = requests.publish("native", "blocking", definitions)!;
  let writes = 0;
  await expect(
    adapter.answer(request, [{ optionIndexes: [0] }, { optionIndexes: [] }], {
      signal: new AbortController().signal,
      frame: () => fixture("features-initial"),
      wait: () => Promise.reject(new Error("unexpected wait")),
      write: () => {
        writes++;
        return Promise.resolve();
      },
    }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writes).toBe(0);
});
