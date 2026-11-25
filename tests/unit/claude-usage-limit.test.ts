/** Verify Claude quota evidence and live transcript boundaries (C-API-68). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
} from "../../src/claude/transcript/index.ts";
import { claudeUsageLimitWarning } from "../../src/claude/transcript/usage-limit.ts";
import { resetFakes, tempDir } from "../claude/helpers.ts";

afterEach(resetFakes);

const message = "You've hit your weekly limit · resets Nov 30 at 12am (America/Los_Angeles)";
const record = {
  type: "assistant",
  uuid: "usage-limit",
  isApiErrorMessage: true,
  apiError: "usage_limit_reached",
  apiErrorParams: { rate_limit_info: { status: "rejected" } },
  message: { model: "<synthetic>", content: [{ type: "text", text: message }] },
};

const source = { elwoodSessionId: "s1", path: "/fixture.jsonl", item: record };

test.each([
  null,
  { ...record, isApiErrorMessage: false },
  { ...record, isSidechain: true },
  { ...record, message: null },
  { ...record, apiErrorParams: null },
  { ...record, apiErrorParams: {} },
  { ...record, apiErrorParams: { rate_limit_info: { status: "allowed_warning" } } },
])("C-API-68 rejects a record without affirmative main-conversation quota evidence", (item) => {
  expect(claudeUsageLimitWarning({ ...source, item }, message)).toBeUndefined();
});

test.each([
  [17, "1700000000"],
  ["native limit with spaces", -1],
])("C-API-68 suppresses unsupported optional fields", (rateLimitType, resetsAt) => {
  const item = {
    ...record,
    apiErrorParams: { rate_limit_info: { status: "rejected", rateLimitType, resetsAt } },
  };
  const warning = claudeUsageLimitWarning({ ...source, item }, "Native quota rejection.");
  expect(warning).toMatchObject({
    message: "Native quota rejection.",
    code: "usage_limit_reached",
  });
  expect(warning).not.toHaveProperty("limitName");
  expect(warning).not.toHaveProperty("nativeLimitType");
  expect(warning).not.toHaveProperty("resetsAtUnixSeconds");
  expect(warning).not.toHaveProperty("turnId");
});

test("C-API-68 preserves bounded native diagnostic and requires nonblank text", () => {
  const oversized = `${message} ${"x".repeat(2_500)}`;
  expect(claudeUsageLimitWarning(source, oversized)).toMatchObject({
    limitName: "weekly",
    message: `${oversized.slice(0, 2_000)}…`,
  });
  expect(claudeUsageLimitWarning(source, " \t")).toBeUndefined();
});

test("C-API-68 backfill and identified subagent output retain ordinary assistant activity", () => {
  const root = tempDir();
  const history = join(root, "past.jsonl");
  const subagent = join(root, "agent.jsonl");
  const line = `${JSON.stringify(record)}\n`;
  const priorPrompt = JSON.stringify({ type: "user", message: { content: "prior" } });
  writeFileSync(history, `${priorPrompt}\n${line}`);
  writeFileSync(subagent, "");
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", (event) => events.push(event));
  try {
    watcher.observe(history, true);
    watcher.observe(subagent, false, undefined, true);
    appendFileSync(subagent, line);
    watcher.scan();
    expect(
      events.map(({ path, summary, usageLimit }) => ({ path, kind: summary.kind, usageLimit })),
    ).toEqual([
      { path: history, kind: "assistant_message", usageLimit: undefined },
      { path: subagent, kind: "assistant_message", usageLimit: undefined },
    ]);
  } finally {
    watcher.finish();
  }
});
