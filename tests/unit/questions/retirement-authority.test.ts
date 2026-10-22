/** Retirement needs candidate-correlated native evidence, never retained prose (PRD §4). */

import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

test("a partial panel without options cannot arm retirement", () => {
  const adapter = new ClaudeQuestionAdapter(registry());
  adapter.observe(nativeHook());
  const native = fixture("questions").text;
  adapter.render(frame(native.slice(0, native.indexOf("❯ 1. Amber"))));
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(true);
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
