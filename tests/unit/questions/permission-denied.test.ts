/** Typed native permission denial closes only its matching question request (PRD §4, §6.4). */
import { expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../../src/claude/hooks/events.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { isClaudeHookInput } from "../../../src/claude/validate/input.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

function permissionDenied(toolUseId: string) {
  const raw = {
    hook_event_name: "PermissionDenied",
    session_id: "claude-native-session",
    cwd: "/tmp/elwood-question-test",
    tool_name: "AskUserQuestion",
    tool_input: { questions: nativeQuestions },
    tool_use_id: toolUseId,
    reason: "Policy denied the question tool.",
  } satisfies ClaudeHookEventFor<"PermissionDenied">;
  return { ...nativeHook("PermissionDenied"), raw };
}

test("validated PermissionDenied closes a matching tool ID once and ignores unrelated IDs", () => {
  const requests = registry();
  const events: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => events.push(event));
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const request = requests.list()[0]!;
  const raised = { elwoodSessionId: "s", agent: "claude", phase: "raised", request };
  expect(events).toEqual([raised]);

  const unrelated = permissionDenied("other-native-tool");
  expect(isClaudeHookInput(unrelated.raw)).toBe(true);
  expect(adapter.observe(unrelated)).toBe(false);
  expect(requests.list()).toEqual([request]);
  expect(events).toEqual([raised]);
  expect(adapter.blocksInput()).toBe(true);

  const matching = permissionDenied("native");
  expect(isClaudeHookInput(matching.raw)).toBe(true);
  expect(adapter.observe(matching)).toBe(true);
  expect(requests.list()).toEqual([]);
  const expected = [
    raised,
    { elwoodSessionId: "s", agent: "claude", phase: "closed", request, reason: "unavailable" },
  ];
  expect(events).toEqual(expected);
  expect(adapter.observe(matching)).toBe(false);
  expect(events).toEqual(expected);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(composer());
  expect(adapter.blocksInput()).toBe(false);
  expect(events).toEqual(expected);
});
