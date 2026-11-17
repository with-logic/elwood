/** Native Claude prompt identities follow each independent transcript chain (PRD §5.4). */
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { observeTranscript } from "../../src/claude/session/transcript.ts";
import type { ClaudeTranscriptEvent } from "../../src/claude/transcript/index.ts";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";
import { ClaudeTranscriptTurns } from "../../src/claude/transcript/turn-identity.ts";
import { assistant, tmpFile } from "./claude-transcript-helpers.ts";

test("C-CLAUDE-15 an initial hook seeds identity when its prompt is already at EOF", () => {
  const path = tmpFile();
  writeFileSync(path, `${JSON.stringify({ type: "user", uuid: "user", promptId: "native" })}\n`);
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event));
  try {
    watcher.observe(path, false, "native");
    observeTranscript(watcher, { transcript_path: path, prompt_id: "" });
    appendFileSync(path, `${JSON.stringify({ ...assistant("reply"), parentUuid: "user" })}\n`);
    watcher.scan();
    expect(events).toMatchObject([{ turnId: "native", summary: { text: "reply" } }]);
  } finally {
    watcher.stop();
  }
});

test("C-CLAUDE-15 chain identity stays separate from hook timing and other paths", () => {
  const turns = new ClaudeTranscriptTurns();
  expect(turns.observe("main", null)).toBeUndefined();
  expect(turns.observe("main", { uuid: "before", promptId: "", parentUuid: 1 })).toBeUndefined();
  expect(turns.observe("main", { uuid: "root", promptId: "first" })).toBe("first");
  turns.seed("main", "second");
  expect(turns.observe("main", { uuid: "first-answer", parentUuid: "root" })).toBe("first");
  expect(turns.observe("main", { uuid: "next", promptId: "second" })).toBe("second");
  expect(turns.observe("main", { parentUuid: "first-answer" })).toBe("first");
  expect(
    turns.observe("main", {
      type: "user",
      uuid: "late-tool",
      promptId: "first",
      parentUuid: "first-answer",
      message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "ok" }] },
    }),
  ).toBe("first");
  expect(turns.observe("subagent", { uuid: "root", promptId: "child" })).toBe("child");
  expect(turns.observe("subagent", { parentUuid: "root" })).toBe("child");
  expect(turns.observe("main", { parentUuid: "next" })).toBe("second");
  expect(turns.observe("main", { parentUuid: "unobserved" })).toBeUndefined();
  expect(turns.observe("main", {})).toBeUndefined();
  expect(turns.observe("main", { promptId: "third", message: { content: [] } })).toBe("third");
  expect(turns.observe("main", { promptId: "fourth", message: { content: "prompt" } })).toBe(
    "fourth",
  );
  expect(turns.observe("main", { promptId: "fifth", message: { content: [null] } })).toBe("fifth");
  expect(
    turns.observe("main", { promptId: "sixth", message: { content: [{ type: "text" }] } }),
  ).toBe("sixth");
});

test("C-CLAUDE-15 a failed path registration cannot seed a later transcript at that path", () => {
  const parent = tmpFile();
  writeFileSync(parent, "not a directory");
  const path = join(parent, "transcript.jsonl");
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event));
  try {
    watcher.observe(path, false, "failed-turn");
    watcher.retire(path);
    unlinkSync(parent);
    mkdirSync(parent);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "user", promptId: "new-turn" })}\n`,
    );
    watcher.observe(path, false, "new-turn");
    appendFileSync(path, `${JSON.stringify({ ...assistant("reply"), parentUuid: "user" })}\n`);
    watcher.scan();
    expect(events).toMatchObject([{ turnId: "new-turn", summary: { text: "reply" } }]);
  } finally {
    watcher.stop();
  }
});

test("C-CLAUDE-15 bounded identity eviction omits unknown chains instead of guessing", () => {
  const turns = new ClaudeTranscriptTurns();
  turns.observe("main", { uuid: "old", promptId: "predecessor" });
  for (let index = 0; index < 4_096; index += 1)
    turns.observe("main", { uuid: `record-${index}`, promptId: "successor" });
  expect(turns.observe("main", { parentUuid: "old" })).toBeUndefined();
  expect(turns.observe("main", { parentUuid: "record-4095" })).toBe("successor");
  turns.forget("main");
  expect(turns.observe("main", { parentUuid: "record-4095" })).toBeUndefined();
});
