/** Native Claude panel publication preserves mapped metadata and event ordering (PRD §4). */
import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import {
  validatedHookActivity as hook,
  permissionRequest,
  postToolUse,
  preToolUse,
} from "./hook-fixtures.ts";

test("publishes only matching native UI, preserves redraw IDs and correlates keyless permission mirrors", () => {
  const requests = registry();
  const events: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => events.push(event));
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe({ ...hook(preToolUse), source: "transcript" });
  adapter.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  expect(events).toEqual([]);
  adapter.observe({ ...hook(preToolUse), kind: "tool_call" });
  adapter.render(fixture("questions"));
  expect(requests.list()).toEqual([]);
  expect(events).toEqual([]);
  adapter.observe(hook(preToolUse));
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
  adapter.observe(hook(permissionRequest));
  adapter.render(fixture("questions"));
  expect(requests.list()[0]).toBe(first);
  expect(events).toEqual([raised]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.observe(hook(postToolUse));
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
