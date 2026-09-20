/** Attention follows a changed human decision while blocked; PRD §5.3 / C-ATTN-03. */
import { expect, test } from "vitest";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";

function reading(ids: readonly string[]) {
  return readScreenFacts(
    {
      agent: "codex",
      verifiedAgainst: "test",
      rules: ids.map((id) => ({ id, fact: "blocking_prompt_visible" as const, all: [/dialog/] })),
    },
    { text: "dialog", title: "" },
  );
}

test("C-ATTN-03 updates the label when an update is replaced by a human-owned prompt", () => {
  const watcher = new AttentionWatcher();
  expect(watcher.observe(reading(["codex-update-prompt"]))).toEqual({
    edge: "raised",
    ruleIds: ["codex-update-prompt"],
  });
  expect(watcher.observe(reading(["codex-retained-prompt"]))).toEqual({
    edge: "updated",
    ruleIds: ["codex-retained-prompt"],
  });
  expect(watcher.observe(reading(["codex-retained-prompt"]))).toBeUndefined();
  expect(watcher.observe(reading([]))).toEqual({ edge: "cleared", ruleIds: [] });
  expect(watcher.observe(reading([]))).toBeUndefined();
});

test("C-ATTN-03 deduplicates reordered ids but reports added or removed rules", () => {
  const watcher = new AttentionWatcher();
  watcher.observe(reading(["a", "b"]));
  expect(watcher.observe(reading(["b", "a"]))).toBeUndefined();
  expect(watcher.observe(reading(["b", "a", "a"]))).toBeUndefined();
  expect(watcher.observe(reading(["a"]))).toEqual({ edge: "updated", ruleIds: ["a"] });
  expect(watcher.observe(reading(["a", "b"]))).toEqual({ edge: "updated", ruleIds: ["a", "b"] });
});
