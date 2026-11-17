/** Native speed evidence stays tied to its original transcript record. C-SPEED-03. */
import { expect, test } from "vitest";
import { claudeSpeedObservation } from "../../src/claude/transcript/speed.ts";
import { summarizeTranscriptItem } from "../../src/codex/transcript/index.ts";
import { codexSpeedObservation } from "../../src/codex/transcript/speed.ts";
import {
  activityFromClaudeTranscript,
  activityFromCodexTranscript,
} from "../../src/core/activity/index.ts";

const codex = (tier: unknown) => ({ type: "turn_context", payload: { service_tier: tier } });
const claude = (speed: unknown) => ({ type: "assistant", message: { usage: { speed } } });

test.each([
  ["default", "default"],
  ["fast", "fast"],
  ["priority", "fast"],
  ["ultrafast", "ultrafast"],
])("C-SPEED-03 Codex %s is turn configuration, not billed usage", (tier, expected) => {
  const item = codex(tier);
  const event = activityFromCodexTranscript({
    elwoodSessionId: "session",
    path: "/native/rollout",
    item,
    summary: summarizeTranscriptItem(item),
  });
  expect(event).toMatchObject({
    transcriptPath: "/native/rollout",
    elwoodSessionId: "session",
    raw: item,
    speed: {
      agent: "codex",
      serviceTier: expected,
      evidence: "turn_configuration",
    },
  });
});

test.each([
  ["standard", false],
  ["fast", true],
])("C-SPEED-03 Claude %s carries response usage and subagent path", (speed, fastMode) => {
  const item = claude(speed);
  const event = activityFromClaudeTranscript({
    elwoodSessionId: "session",
    path: "/native/subagent",
    item,
    summary: { kind: "assistant_message", label: "assistant", text: "hello" },
  });
  expect(event).toMatchObject({
    elwoodSessionId: "session",
    transcriptPath: "/native/subagent",
    raw: item,
    speed: { agent: "claude", fastMode, evidence: "response_usage" },
  });
});

test.each([
  undefined,
  null,
  [],
  true,
  "text",
  {},
  { type: "other" },
  codex("new-tier"),
  codex(null),
  { type: "turn_context", payload: [] },
  { type: "turn_context" },
  { type: "assistant" },
  { type: "assistant", message: { usage: [] } },
  claude("ultrafast"),
  claude(null),
])("C-SPEED-03 absent or unknown data never becomes standard: %j", (item) => {
  expect(codexSpeedObservation(item)).toEqual({});
  expect(claudeSpeedObservation(item)).toEqual({});
});

test.each([
  {
    name: "absent",
    payload: { model: "gpt-6-astra" },
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  {
    name: "unknown",
    payload: { model: "gpt-6-astra", service_tier: "unknown" },
    usage: { input_tokens: 1, output_tokens: 1, speed: "unknown" },
  },
  {
    name: "null",
    payload: { model: "gpt-6-astra", service_tier: null },
    usage: { input_tokens: 1, output_tokens: 1, speed: null },
  },
])("C-SPEED-03 public activity leaves $name speed absent", ({ payload, usage }) => {
  const codexItem = {
    type: "turn_context",
    payload,
  };
  const codexEvent = activityFromCodexTranscript({
    elwoodSessionId: "s",
    path: "/codex",
    item: codexItem,
    summary: summarizeTranscriptItem(codexItem),
  });
  expect(codexEvent).not.toHaveProperty("speed");
  const claudeItem = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      usage,
    },
  };
  const claudeEvent = activityFromClaudeTranscript({
    elwoodSessionId: "s",
    path: "/claude",
    item: claudeItem,
    summary: { kind: "assistant_message", label: "assistant", text: "hello" },
  });
  expect(claudeEvent).not.toHaveProperty("speed");
});
