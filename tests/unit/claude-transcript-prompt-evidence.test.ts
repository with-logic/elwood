/** Bounds retained prompt evidence without weakening exact native matching (PRD §5.4). */
import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";
import { ClaudeUserPrompts } from "../../src/claude/transcript/user-prompts.ts";
import { userPromptText } from "../../src/claude/transcript/user-record.ts";

import { nativeUser, tmpFile, writeRecords } from "./claude-transcript-helpers.ts";

const path = "/transcript.jsonl";
const record = (promptId: string, text = "native prompt") => ({
  type: "user",
  promptId,
  message: { content: text },
});

test("keeps exact matching evidence separate across transcript paths", () => {
  const events: unknown[] = [];
  const prompts = new ClaudeUserPrompts((event) => events.push(event));
  const commit = (target: string, id: string, text?: string) => {
    const item = record(id, text);
    prompts.observeForwardRecord(target, id, item);
  };
  commit(path, "cached");
  commit(path, "cached", "duplicate");
  prompts.observeHook("/other.jsonl", "cached", false);
  prompts.observeHook(path, "waiting", false);
  prompts.observeHook(path, "waiting", false);
  commit("/other.jsonl", "waiting", "wrong path");
  expect(events).toEqual([]);
  prompts.observeHook(path, "cached", false);
  commit(path, "waiting");
  expect(events).toMatchObject([
    { turnId: "cached", summary: { text: "native prompt" } },
    { turnId: "waiting", summary: { text: "native prompt" } },
  ]);
});

test("bounds retained history and keeps live text when native metadata exceeds its limits", () => {
  const events: unknown[] = [];
  const prompts = new ClaudeUserPrompts((event) => events.push(event));
  const commit = (target: string, id: string, padding = "") => {
    prompts.observeForwardRecord(target, id, record(id, `native prompt${padding}`));
  };
  expect(prompts.observeHook(undefined, "pathless", false)).toBe(false);
  expect(prompts.observeHook(undefined, "pathless", true)).toBe(true);
  const oversizedPath = `/${"p".repeat(4097)}`;
  const oversizedId = "t".repeat(1025);
  expect(prompts.observeHook(oversizedPath, "unbound", false)).toBe(false);
  commit(oversizedPath, "unbound");
  commit(path, oversizedId);
  expect(prompts.observeHook(path, oversizedId, true)).toBe(true);

  const padding = " ".repeat(900 * 1024);
  for (const id of ["evicted", "first", "second", "third", "retained"]) commit(path, id, padding);
  prompts.observeHook(path, "evicted", false);
  prompts.observeHook(path, "retained", false);
  expect(events).toMatchObject([{ turnId: "retained" }]);

  for (let index = 0; index < 64; index++) {
    prompts.observeHook(path, `hook-${index}`, false);
    expect(prompts.observeHook(path, `shown-${index}`, true)).toBe(true);
  }
  // Consume the oldest retained hook before recording new evidence for the evicted one.
  commit(path, "hook-0");
  commit(path, "evicted");
  expect(events).toMatchObject([{ turnId: "retained" }, { turnId: "hook-0" }]);
  expect(prompts.observeHook(path, "retained", true)).toBe(true);
});

test("requires user text and excludes transcript metadata and tool output", () => {
  expect(
    userPromptText({ ...record("id"), message: { role: "assistant", content: "wrong role" } }),
  ).toBeUndefined();
  expect(userPromptText({ ...record("id"), message: null })).toBeUndefined();
  expect(userPromptText(record("id", " \n\t"))).toBeUndefined();
  expect(userPromptText(record("id", "\u0085"))).toBeUndefined();
  expect(userPromptText(record("id", "\ufeff"))).toBe("\ufeff");
  expect(userPromptText({ ...record("id"), isMeta: true })).toBeUndefined();
  expect(
    userPromptText({ ...record("id"), message: { content: [{ type: "text", text: null }] } }),
  ).toBeUndefined();
  expect(
    userPromptText({
      ...record("id"),
      message: { content: [{ type: "text", text: "annotation" }, { type: "tool_result" }] },
    }),
  ).toBeUndefined();
});

test("C-API-63 a malformed live identity stops transcript correlation without suppressing hooks", () => {
  const path = tmpFile();
  const events: unknown[] = [];
  const watcher = new ClaudeTranscriptWatcher("s", (event) => events.push(event));
  writeRecords(path);
  try {
    watcher.observe(path);
    watcher.observeUserPromptHook({ path, turnId: "first", hasText: false });
    watcher.observeUserPromptHook({ path, turnId: "shown", hasText: false });
    writeRecords(path, nativeUser("shown", "delivered once"));
    watcher.scan();
    expect(events).toHaveLength(1);
    appendFileSync(
      path,
      `${JSON.stringify({ ...nativeUser("other", "malformed identity"), uuid: "u".repeat(1025) })}\n`,
    );
    appendFileSync(path, `${JSON.stringify(nativeUser("first", "must stay hidden"))}\n`);
    watcher.scan();
    expect(events).toHaveLength(1);
    expect(watcher.observeUserPromptHook({ path, turnId: "shown", hasText: true })).toBe(false);
    expect(watcher.observeUserPromptHook({ path, turnId: "first", hasText: true })).toBe(true);
  } finally {
    watcher.finish();
  }
});

test("C-API-63 a valid final record can recover prompt text without a trailing newline", () => {
  const path = tmpFile();
  const events: unknown[] = [];
  const watcher = new ClaudeTranscriptWatcher("s", (event) => events.push(event));
  writeRecords(path);
  try {
    watcher.observe(path);
    watcher.observeUserPromptHook({ path, turnId: "final", hasText: false });
    appendFileSync(path, JSON.stringify(nativeUser("final", "native final text")));
    watcher.scan();
    expect(events).toEqual([]);
    watcher.finish();
    expect(events).toMatchObject([
      { turnId: "final", summary: { kind: "user_message", text: "native final text" } },
    ]);
  } finally {
    watcher.finish();
  }
});
