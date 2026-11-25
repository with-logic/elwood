/** Verify Claude quota evidence and live transcript boundaries (C-API-68). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
} from "../../src/claude/transcript/index.ts";
import type { ClaudeDirectRecordSummary } from "../../src/claude/transcript/summary.ts";
import { claudeUsageLimitWarning } from "../../src/claude/transcript/usage-limit.ts";
import type { ClaudeUsageLimitWarning } from "../../src/core/warnings/transcript.ts";
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

function summary(text: string): ClaudeDirectRecordSummary {
  return { kind: "assistant_message", label: "assistant", text };
}

const source = { elwoodSessionId: "s1", path: "/fixture.jsonl", item: record };

test.each([
  null,
  { ...record, isApiErrorMessage: false },
  { ...record, apiError: "rate_limit" },
  { ...record, isSidechain: true },
  { ...record, message: null },
  { ...record, apiErrorParams: null },
  { ...record, apiErrorParams: {} },
  { ...record, apiErrorParams: { rate_limit_info: { status: "allowed_warning" } } },
])("C-API-68 rejects a record without affirmative main-conversation quota evidence", (item) => {
  expect(claudeUsageLimitWarning({ ...source, item }, [summary(message)])).toBeUndefined();
});

test.each([
  [17, "1700000000"],
  ["native limit with spaces", -1],
])("C-API-68 suppresses unsupported optional fields", (rateLimitType, resetsAt) => {
  const item = {
    ...record,
    apiErrorParams: { rate_limit_info: { status: "rejected", rateLimitType, resetsAt } },
  };
  const warning = claudeUsageLimitWarning({ ...source, item }, [
    summary("Native quota rejection."),
  ]);
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
  expect(claudeUsageLimitWarning(source, [summary(oversized)])).toMatchObject({
    limitName: "weekly",
    message: `${oversized.slice(0, 2_000)}…`,
  });
  expect(claudeUsageLimitWarning(source, [summary(" \t")])).toBeUndefined();
});

test.each([
  [64, 0],
  [64, Number.MAX_SAFE_INTEGER],
  [65, Number.MAX_SAFE_INTEGER + 1],
])("C-API-68 trims the diagnostic and bounds metadata (%s characters, reset %s)", (length, resetsAt) => {
  const name = "A".repeat(length);
  const nativeType = "a".repeat(length);
  const text = `You've hit your ${name} limit · resets tonight`;
  const item = {
    ...record,
    apiErrorParams: {
      rate_limit_info: { status: "rejected", rateLimitType: nativeType, resetsAt },
    },
  };
  const warning = claudeUsageLimitWarning({ ...source, item }, [summary(` \n${text} \t`)]);
  expect(warning).toEqual({
    elwoodSessionId: source.elwoodSessionId,
    agent: "claude",
    source: "transcript",
    code: "usage_limit_reached",
    severity: "warning",
    message: text,
    transcriptPath: source.path,
    raw: "usage_limit_reached",
    ...(length === 64
      ? { limitName: name, nativeLimitType: nativeType, resetsAtUnixSeconds: resetsAt }
      : {}),
  });
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
  const warnings: ClaudeUsageLimitWarning[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", (event) => events.push(event), {
    onUsageLimit: (warning) => warnings.push(warning),
  });
  try {
    watcher.observe(history, true);
    watcher.observe(subagent, false, undefined, true);
    appendFileSync(subagent, line);
    watcher.scan();
    expect(events.map(({ path, summary }) => ({ path, kind: summary.kind }))).toEqual([
      { path: history, kind: "assistant_message" },
      { path: subagent, kind: "assistant_message" },
    ]);
    expect(warnings).toEqual([]);
  } finally {
    watcher.finish();
  }
});

test("C-API-68 a rewind rereads old activity and a later append still reports quota", () => {
  const path = join(tempDir(), "transcript.jsonl");
  const history = `${JSON.stringify(record)}\n`;
  writeFileSync(path, `${history}${" ".repeat(2_000)}\n`);
  const currentMessage = "You've hit your Fable limit · resets tonight";
  const current = Buffer.from(
    `${JSON.stringify({
      ...record,
      uuid: "fresh-limit",
      message: { model: "<synthetic>", content: [{ type: "text", text: currentMessage }] },
    })}\n`,
  );
  // The observed rewind ends after the first byte of the UTF-8 middle dot.
  const split = current.indexOf("·") + 1;
  const messages: string[] = [];
  const warnings: ClaudeUsageLimitWarning[] = [];
  const watcher = new ClaudeTranscriptWatcher(
    "s1",
    ({ summary }) => {
      if (summary.kind === "assistant_message") messages.push(summary.text);
    },
    { onUsageLimit: (warning) => warnings.push(warning) },
  );
  try {
    watcher.observe(path);
    writeFileSync(path, Buffer.concat([Buffer.from(history), current.subarray(0, split)]));
    watcher.scan();
    expect(messages).toEqual([message]);
    expect(warnings).toEqual([]);
    appendFileSync(path, current.subarray(split));
    watcher.scan();
    expect(messages).toEqual([message, currentMessage]);
    expect(warnings).toMatchObject([{ message: currentMessage, limitName: "Fable" }]);
  } finally {
    watcher.finish();
  }
});

test("C-API-68 final drain keeps the replay classification of a retained quota record", () => {
  const path = join(tempDir(), "transcript.jsonl");
  const prior = JSON.stringify(record);
  writeFileSync(path, `${prior}\n${" ".repeat(2_000)}\n`);
  const messages: string[] = [];
  const warnings: ClaudeUsageLimitWarning[] = [];
  const watcher = new ClaudeTranscriptWatcher(
    "s1",
    ({ summary }) => {
      if (summary.kind === "assistant_message") messages.push(summary.text);
    },
    { onUsageLimit: (warning) => warnings.push(warning) },
  );
  try {
    watcher.observe(path);
    writeFileSync(path, prior);
    watcher.finish();
    expect(messages).toEqual([message]);
    expect(warnings).toEqual([]);
  } finally {
    watcher.finish();
  }
});
