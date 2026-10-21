/** Codex public progress remains distinct from final replies (PRD §5.4, C-CODEX-22). */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCodexTranscriptWatcher } from "../../src/codex/session/transcript.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import { summarizeTranscriptItem } from "../../src/codex/transcript/summary.ts";
import {
  activityFromCodexTranscript,
  type ElwoodActivityEvent,
} from "../../src/core/activity/index.ts";
import { toTurnEvent } from "../../src/core/simple/events.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDirForUnit } from "./helpers.ts";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/codex/commentary.json", import.meta.url), "utf8"),
);
const message = (phase: string, content: unknown, role = "assistant") => ({
  type: "response_item",
  payload: { type: "message", role, phase, content },
});
const mirror = (phase: string, text: string) => ({
  type: "event_msg",
  payload: { type: "agent_message", phase, message: text },
});
const project = (item: unknown) =>
  activityFromCodexTranscript({
    elwoodSessionId: "s1",
    path: "/rollout.jsonl",
    item,
    summary: summarizeTranscriptItem(item),
  });

test("C-CODEX-22 preserves the reported completed commentary fixture as normalized progress", () => {
  const event = project(fixture);
  expect(event).toMatchObject({
    elwoodSessionId: "s1",
    agent: "codex",
    source: "transcript",
    kind: "assistant_progress",
    label: "assistant",
    transcriptPath: "/rollout.jsonl",
    text: "I’ve added a focused end-to-end case for the connection. The first run could not start because this checkout has no installed workspace dependencies. I’m installing the locked dependencies, then I’ll rerun it to confirm the expected failure before implementing the path.",
    raw: fixture,
  });
  expect(toTurnEvent(event)).toBeUndefined();
});

test("C-CODEX-22 retains final parity and joins only output_text commentary blocks", () => {
  const content = [
    { type: "output_text", text: "First. " },
    { type: "reasoning_text", text: "private analysis" },
    null,
    { type: "output_text", text: 7 },
    { type: "output_text", text: "Second." },
  ];
  expect(project(message("commentary", content))).toMatchObject({
    kind: "assistant_progress",
    text: "First. Second.",
  });
  const final = project(message("final_answer", content));
  expect(final).toMatchObject({ kind: "assistant_message", text: "First. Second." });
  expect(toTurnEvent(final)).toEqual({ type: "text", text: "First. Second." });
  expect(
    project({
      type: "response_item",
      payload: { type: "message", role: "assistant", phase: null, content: "Legacy" },
    }),
  ).toMatchObject({ kind: "assistant_message", text: "Legacy" });
  expect(
    project({
      type: "event_msg",
      payload: { type: "agent_message", phase: null, message: "Legacy" },
    }),
  ).toMatchObject({ kind: "assistant_message", text: "Legacy" });
  expect(project(mirror("final_answer", "Final mirror"))).toMatchObject({
    kind: "assistant_message",
    text: "Final mirror",
  });
  expect(project(message("commentary", "String progress"))).toMatchObject({
    kind: "assistant_progress",
    text: "String progress",
  });
});

test.each([
  message("analysis", "private"),
  message("future", "private"),
  message("commentary", "user text", "user"),
  message("commentary", [{ type: "reasoning_text", text: "private" }]),
  mirror("commentary", "mirror"),
  mirror("analysis", "private"),
  {
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: 7, content: "private" },
  },
  { type: "event_msg", payload: { type: "agent_message", phase: 7, message: "private" } },
])("C-CODEX-22 excludes analysis, unknown phases and noncanonical mirrors: %j", (item) => {
  expect(project(item)).toMatchObject({ kind: "other" });
  expect(project(item).text).toBeUndefined();
});

test("C-CODEX-22 suppressed legacy mirrors retain their raw item-type label", () => {
  expect(project(mirror("commentary", "mirror"))).toMatchObject({
    kind: "other",
    label: "agent_message",
  });
});

test("C-CODEX-22 real watcher emits progress updates and one final in order without mirror duplicates", () => {
  const path = join(tempDirForUnit(), "rollout.jsonl");
  writeFileSync(path, "");
  const emitter = new TypedEmitter<CodexEventMap>();
  const { watcher } = createCodexTranscriptWatcher("s1", emitter, () => undefined);
  const readable: ElwoodActivityEvent[] = [];
  const raw: unknown[] = [];
  emitter.on("codex:transcript", (event) => raw.push(event.item));
  emitter.on("activity", (event) => {
    if (event.kind === "assistant_message" || event.kind === "assistant_progress")
      readable.push(event);
  });
  watcher.observe(path);
  const items = [
    mirror("commentary", "First"),
    message("commentary", "First"),
    message("commentary", [{ type: "output_text", text: "Second" }]),
    mirror("commentary", "Second"),
    message("commentary", "First"),
    message("final_answer", "Done"),
  ];
  try {
    for (const item of items) {
      appendFileSync(path, `${JSON.stringify(item)}\n`);
      watcher.scan();
    }
    expect(raw).toEqual(items);
    expect(readable.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "assistant_progress", text: "First" },
      { kind: "assistant_progress", text: "Second" },
      { kind: "assistant_progress", text: "First" },
      { kind: "assistant_message", text: "Done" },
    ]);
  } finally {
    watcher.finish();
  }
});
