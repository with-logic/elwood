/** Only matching genuine baseline prompts seed transcript identity (PRD §5.4 / C-CLAUDE-15). */
import { appendFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../src/claude/transcript/cursor.ts";
import type { ClaudeTranscriptEvent } from "../../src/claude/transcript/index.ts";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";
import { ClaudeTranscriptTurns } from "../../src/claude/transcript/turn-identity.ts";
import { assistant, tmpFile } from "./claude-transcript-helpers.ts";

test.each([
  {
    name: "a different native prompt",
    record: { type: "user", uuid: "old-user", promptId: "old", message: { content: "prompt" } },
  },
  {
    name: "a pure tool result",
    record: {
      type: "user",
      uuid: "old-user",
      promptId: "native",
      message: { content: [{ type: "tool_result", tool_use_id: "call", content: "ok" }] },
    },
  },
  {
    name: "assistant history",
    record: {
      type: "assistant",
      uuid: "old-user",
      promptId: "native",
      message: { content: "old reply" },
    },
  },
])("C-CLAUDE-15 $name cannot seed a successor's EOF identity", ({ record }) => {
  const path = tmpFile();
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event));
  try {
    watcher.observe(path, false, "native");
    appendFileSync(
      path,
      `${JSON.stringify({ ...assistant("late reply"), parentUuid: "old-user" })}\n`,
    );
    watcher.scan();
    expect(events).toHaveLength(1);
    expect(events[0]?.turnId).toBeUndefined();
  } finally {
    watcher.stop();
  }
});

test("C-CLAUDE-15 Stop-first tail recovery uses only its matched native baseline user", () => {
  const path = tmpFile();
  writeFileSync(
    path,
    `${JSON.stringify({ type: "user", uuid: "root", promptId: "native", message: { content: "prompt" } })}\n${JSON.stringify({ ...assistant("committed reply"), parentUuid: "root" })}\n`,
  );
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event));
  try {
    watcher.observe(path, true, "native");
    expect(events).toMatchObject([{ turnId: "native", summary: { text: "committed reply" } }]);
  } finally {
    watcher.stop();
  }
});

test("C-CLAUDE-15 an established native chain never rereads a later hook baseline", () => {
  const turns = new ClaudeTranscriptTurns();
  expect(turns.observe("p", { uuid: "root", promptId: "native" })).toBe("native");
  turns.seed("p", "successor", () => {
    throw new Error("must not reread baseline");
  });
  expect(turns.observe("p", { parentUuid: "root" })).toBe("native");
});

test("C-CLAUDE-15 a failed baseline identity read is contained and cannot seed unknown ancestry", () => {
  const path = tmpFile();
  writeFileSync(
    path,
    `${JSON.stringify({ type: "user", uuid: "root", promptId: "native", message: { content: "prompt" } })}\n`,
  );
  const events: ClaudeTranscriptEvent[] = [];
  const notices: unknown[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event), {
    onReadError: (notice) => notices.push(notice),
  });
  try {
    setByteReaderForTests(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    expect(() => watcher.observe(path, false, "native")).not.toThrow();
    resetByteReaderForTests();
    expect(notices).toHaveLength(1);
    appendFileSync(path, `${JSON.stringify({ ...assistant("reply"), parentUuid: "root" })}\n`);
    watcher.scan();
    expect(events).toHaveLength(1);
    expect(events[0]?.turnId).toBeUndefined();
  } finally {
    resetByteReaderForTests();
    watcher.stop();
  }
});

test("C-CLAUDE-15 a baseline identity overflow prevents later blank-hook recovery", () => {
  const first = tmpFile();
  const overflow = tmpFile();
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event));
  const prompt = (promptId: string, uuid: string) =>
    JSON.stringify({ type: "user", uuid, promptId, message: { content: "prompt" } });
  try {
    writeFileSync(first, "");
    watcher.observe(first);
    expect(watcher.observeUserPromptHook({ path: first, turnId: "pending", hasText: false })).toBe(
      false,
    );
    appendFileSync(first, `${prompt("cached-before-overflow", "cached")}\n`);
    watcher.scan();
    writeFileSync(overflow, `${prompt("overflow", "x".repeat(1_025))}\n`);
    watcher.observe(overflow, false, "overflow");
    appendFileSync(first, `${prompt("pending", "valid")}\n`);
    watcher.scan();
    expect(
      watcher.observeUserPromptHook({
        path: first,
        turnId: "cached-before-overflow",
        hasText: false,
      }),
    ).toBe(false);
    expect(events).toEqual([]);
    expect(
      watcher.observeUserPromptHook({
        path: first,
        turnId: "known",
        hasText: true,
        prompt: "live",
      }),
    ).toBe(true);
  } finally {
    watcher.stop();
  }
});

test("C-CLAUDE-15 retirement forgets only its own unpaired prompt evidence", () => {
  const retired = tmpFile();
  const retained = tmpFile();
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("session", (event) => events.push(event));
  try {
    for (const [path, promptId] of [
      [retired, "old"],
      [retained, "live"],
    ] as const) {
      writeFileSync(path, "");
      watcher.observe(path);
      appendFileSync(
        path,
        `${JSON.stringify({ type: "user", promptId, message: { content: promptId } })}\n`,
      );
    }
    watcher.scan();
    watcher.retire(retired);
    watcher.observeUserPromptHook({ path: retired, turnId: "old", hasText: false });
    watcher.observeUserPromptHook({ path: retained, turnId: "live", hasText: false });
    expect(events).toMatchObject([
      { path: retained, summary: { kind: "user_message", text: "live" } },
    ]);
  } finally {
    watcher.stop();
  }
});
