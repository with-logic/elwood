/** Verifies final assistant-message extraction independently of report validation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { finalText } from "../output.mjs";

const event = (type, messageID, extra = {}) => ({ type, part: { messageID, ...extra } });
const step = (id, text, reason = "stop") => [
  event("step_start", id),
  event("text", id, { text }),
  event("step_finish", id, { reason }),
];
const jsonl = (events) => `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

test("only the final stopped message survives tool progress and earlier assistant text", () => {
  const events = [
    ...step("progress", "I will inspect files", "tool-calls"),
    event("step_start", "final"),
    event("tool_use", "final", { state: { output: "PRIVATE TOOL TEXT" } }),
    event("text", "final", { text: "# Review" }),
    event("text", "final", { text: "Verdict: clean, no notes" }),
    event("step_finish", "final", { reason: "stop" }),
  ];
  assert.equal(finalText(jsonl(events)), "# Review\nVerdict: clean, no notes");
  assert.equal(finalText(jsonl([...step("old", "OLD"), ...step("new", "NEW")])), "NEW");
});

test("malformed, failed, mismatched, empty and incomplete event streams reject", () => {
  const invalid = [
    "",
    "PRIVATE RAW OUTPUT",
    "null\n",
    "{}\n",
    jsonl(step("one", "text").slice(0, -1)),
    jsonl(step("one", "text", "length")),
    jsonl(step("one", "", "stop")),
    jsonl([event("text", "one", { text: "orphan" })]),
    jsonl([event("step_start", "one"), ...step("two", "overlap")]),
    jsonl([event("step_start", "one"), event("text", "other", { text: "mismatch" })]),
    jsonl([...step("one", "text"), { type: "error", error: "PRIVATE ERROR" }]),
    jsonl([...step("one", "text"), event("text", "one", { text: "after stop" })]),
    `${jsonl(step("one", "text"))}{"type":`,
  ];
  for (const input of invalid) assert.throws(() => finalText(input));
});

test("CLI emits no partial text or raw error when the transport is invalid", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../output.mjs", import.meta.url))],
    {
      input: `${jsonl(step("one", "PRIVATE FINAL"))}PRIVATE MALFORMED`,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "review: invalid or incomplete model event stream\n");
});
