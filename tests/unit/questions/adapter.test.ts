/** Claude source correlation, native lifecycle and unsupported candidate handling (PRD §4). */

import { describe, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { nativeHook as hook } from "./lifecycle-helpers.ts";

describe("Claude hook candidates", () => {
  test("publishes only matching native UI, preserves redraw IDs and correlates keyless permission mirrors", () => {
    const requests = registry();
    const events: ElwoodQuestionEvent[] = [];
    requests.onEvent((event) => events.push(event));
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe({ ...hook("PreToolUse"), source: "transcript" });
    adapter.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
    expect(events).toEqual([]);
    adapter.observe({ ...hook("PreToolUse"), kind: "tool_call" });
    adapter.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
    expect(events).toEqual([]);
    adapter.observe(hook("PreToolUse"));
    expect(events).toEqual([]);
    adapter.render(frame("ordinary prose"));
    expect(requests.list()).toEqual([]);
    expect(events).toEqual([]);
    adapter.render(fixture("questions"));
    const first = requests.list()[0]!;
    expect(first).toMatchObject({
      agent: "claude",
      delivery: "blocking",
      questions: [
        {
          prompt: "Which test color?",
          header: "Color",
          options: [
            { label: "Amber", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
          selection: "single",
          textMode: "alternative",
          secret: false,
        },
        {
          prompt: "Which test features?",
          header: "Features",
          options: [
            { label: "Logging", description: "Logs" },
            { label: "Metrics", description: "Counts" },
          ],
          selection: "multiple",
          textMode: "none",
          secret: false,
        },
      ],
    });
    const raised = { elwoodSessionId: "s", agent: "claude", phase: "raised", request: first };
    expect(events).toEqual([raised]);
    adapter.observe(hook("PermissionRequest", { tool_use_id: undefined }));
    adapter.render(fixture("questions"));
    expect(requests.list()[0]).toBe(first);
    expect(events).toEqual([raised]);
    expect(adapter.blocksInput()).toBe(true);
    adapter.observe(hook("PostToolUse", { tool_response: { answers: {} } }));
    adapter.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
    expect(events).toEqual([
      raised,
      {
        elwoodSessionId: "s",
        agent: "claude",
        phase: "closed",
        request: first,
        reason: "answered",
      },
    ]);
    adapter.render(frame("❯ "));
    expect(adapter.blocksInput()).toBe(false);
  });
  test("replacement invalidates prior ID; unrelated/invalid hooks cannot create or close it", () => {
    const requests = registry();
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook("PreToolUse"));
    adapter.render(fixture("questions"));
    const old = requests.list()[0]!;
    adapter.observe(hook("PreToolUse", { tool_use_id: "replacement" }));
    adapter.render(fixture("questions"));
    expect(requests.get(old.id)).toBeUndefined();
    adapter.observe(hook("PostToolUse", { tool_use_id: "old" }));
    expect(requests.list()).toHaveLength(1);
    adapter.observe(hook("Notification"));
    adapter.observe(hook("PreToolUse", { tool_name: "Bash" }));
    adapter.observe(hook("PreToolUse", { tool_input: { questions: "invalid" } }));
    expect(requests.list()).toHaveLength(1);
    adapter.observe(hook("PostToolUseFailure", { tool_use_id: "replacement" }));
    expect(requests.list()).toEqual([]);
  });
  test("keyless candidates deduplicate, decline prose retains authority, and native cancellation closes", () => {
    const requests = registry();
    const events: ElwoodQuestionEvent[] = [];
    requests.onEvent((event) => events.push(event));
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook("PermissionRequest", { tool_use_id: undefined }));
    adapter.render(fixture("questions"));
    expect(requests.list()).toHaveLength(1);
    const request = requests.list()[0]!;
    adapter.render(frame("⏺ User declined to answer questions\n❯ "));
    expect(requests.list()).toHaveLength(1);
    expect(adapter.blocksInput()).toBe(true);
    adapter.observe(hook("PostToolUseFailure", { tool_use_id: undefined, is_interrupt: true }));
    expect(requests.list()).toEqual([]);
    expect(events).toEqual([
      { elwoodSessionId: "s", agent: "claude", phase: "raised", request },
      { elwoodSessionId: "s", agent: "claude", phase: "closed", request, reason: "cancelled" },
    ]);
    adapter.observe(hook("PreToolUse", { tool_input: { questions: [] } }));
    adapter.render(fixture("questions"));
    expect(requests.list()).toEqual([]);
  });
  test("only an unblocked Stop result retires a native request", () => {
    const requests = registry();
    const adapter = new ClaudeQuestionAdapter(requests);
    adapter.observe(hook("PreToolUse"));
    adapter.render(fixture("questions"));
    adapter.observe(hook("Stop"));
    expect(requests.list()).toHaveLength(1);
    const stopResult = {
      ...hook("Stop"),
      kind: "hook_result" as const,
      hookEventName: "Stop",
      raw: { result: { decision: "block" } },
    };
    adapter.observe(stopResult);
    expect(requests.list()).toHaveLength(1);
    adapter.observe({ ...stopResult, raw: { result: undefined } });
    expect(requests.list()).toEqual([]);
  });
});
