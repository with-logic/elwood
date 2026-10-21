/** Claude source correlation, native lifecycle and unsupported candidate handling (PRD §4). */

import { describe, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../../src/claude/hooks/events.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import {
  validatedHookActivity as hook,
  notification,
  permissionDenied,
  permissionRequest,
  postToolUse,
  postToolUseFailure,
  preToolUse,
  stop,
} from "./hook-fixtures.ts";

/** Deliberately bypass hook validation to exercise the adapter's malformed-input guard. */
function malformedQuestionHook(questions: unknown) {
  return {
    ...hook(preToolUse),
    raw: { ...preToolUse, tool_input: { questions } },
  } satisfies ElwoodActivityEvent;
}
describe("Claude hook candidates", () => {
  test.each([
    postToolUseFailure,
    permissionDenied,
  ])("closes native request on $hook_event_name", (event) => {
    const requests = registry();
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook(preToolUse));
    adapter.render(fixture("questions"));
    expect(requests.list()).toHaveLength(1);
    adapter.observe(hook(event));
    expect(requests.list()).toEqual([]);
  });
  test("replacement invalidates prior ID; unrelated/invalid hooks cannot create or close it", () => {
    const requests = registry();
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook(preToolUse));
    adapter.render(fixture("questions"));
    const old = requests.list()[0]!;
    adapter.observe(
      hook({
        ...preToolUse,
        tool_use_id: "replacement",
      } satisfies ClaudeHookEventFor<"PreToolUse">),
    );
    adapter.render(fixture("questions"));
    expect(requests.get(old.id)).toBeUndefined();
    adapter.observe(
      hook({ ...postToolUse, tool_use_id: "old" } satisfies ClaudeHookEventFor<"PostToolUse">),
    );
    expect(requests.list()).toHaveLength(1);
    adapter.observe(hook(notification));
    adapter.observe(
      hook({
        ...preToolUse,
        tool_name: "Bash",
        tool_input: { command: "true" },
      } satisfies ClaudeHookEventFor<"PreToolUse">),
    );
    adapter.observe(malformedQuestionHook("invalid"));
    expect(requests.list()).toHaveLength(1);
    adapter.observe(
      hook({
        ...postToolUseFailure,
        tool_use_id: "replacement",
      } satisfies ClaudeHookEventFor<"PostToolUseFailure">),
    );
    expect(requests.list()).toEqual([]);
  });
  test("keyless candidates deduplicate, decline prose retains authority, and native cancellation closes", () => {
    const requests = registry();
    const events: ElwoodQuestionEvent[] = [];
    requests.onEvent((event) => events.push(event));
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook(permissionRequest));
    adapter.render(fixture("questions"));
    expect(requests.list()).toHaveLength(1);
    const request = requests.list()[0]!;
    adapter.render(frame("⏺ User declined to answer questions\n❯ "));
    expect(requests.list()).toHaveLength(1);
    expect(adapter.blocksInput()).toBe(true);
    adapter.observe(
      hook({
        ...permissionRequest,
        hook_event_name: "PostToolUseFailure",
        error: "Question interrupted",
        is_interrupt: true,
      } satisfies ClaudeHookEventFor<"PostToolUseFailure">),
    );
    expect(requests.list()).toEqual([]);
    expect(events).toEqual([
      { elwoodSessionId: "s", agent: "claude", phase: "raised", request },
      { elwoodSessionId: "s", agent: "claude", phase: "closed", request, reason: "cancelled" },
    ]);
    adapter.observe(
      hook({
        ...preToolUse,
        tool_input: { questions: [] },
      } satisfies ClaudeHookEventFor<"PreToolUse">),
    );
    adapter.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
  });
  test("only an unblocked Stop result retires a native request", () => {
    const requests = registry();
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook(preToolUse));
    adapter.render(fixture("questions"));
    adapter.observe(hook(stop));
    expect(requests.list()).toHaveLength(1);
    const stopResult = {
      ...hook(stop),
      kind: "hook_result" as const,
      hookEventName: "Stop",
      raw: { result: { decision: "block" } },
    };
    adapter.observe(stopResult);
    expect(requests.list()).toHaveLength(1);
    adapter.observe({ ...stopResult, raw: { result: undefined } });
    expect(requests.list()).toEqual([]);
  });
  test("unknown native questionnaire rows retain the input hold without publishing guessed metadata", () => {
    const requests = registry();
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook(preToolUse));
    adapter.render(frame(fixture("questions").text.replace("2. Blue", "2. Violet")));
    expect(adapter.blocksInput()).toBe(true);
    expect(requests.list()).toEqual([]);
  });
});
