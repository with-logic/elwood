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
  "default",
  "fast",
  "priority",
  "ultrafast",
])("C-SPEED-03 Codex %s is turn configuration, not billed usage", (tier) => {
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
      serviceTier: tier === "priority" ? "fast" : tier,
      evidence: "turn_configuration",
    },
  });
});

test.each([
  "standard",
  "fast",
])("C-SPEED-03 Claude %s carries response usage and subagent path", (speed) => {
  const item = claude(speed);
  const event = activityFromClaudeTranscript({
    elwoodSessionId: "session",
    path: "/native/subagent",
    item,
    summary: { kind: "assistant_message", label: "assistant", text: "hello" },
  });
  expect(event).toMatchObject({
    transcriptPath: "/native/subagent",
    raw: item,
    speed: { agent: "claude", fastMode: speed === "fast", evidence: "response_usage" },
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
