/** Completed-render observation and observer failure containment (C-QUESTION-01/02). */
import { afterEach, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { SessionQuestions } from "../../../src/core/questions/controller.ts";
import type { ElwoodCommonEventMap } from "../../../src/core/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { definitions, fixture } from "./helpers.ts";

const terminals: ReturnType<typeof createHeadlessTerminal>[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});
test("C-QUESTION-01 direct completed renders discover questions despite throwing observers", async () => {
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, () => {});
  terminals.push(terminal);
  const events = new TypedEmitter<ElwoodCommonEventMap>();
  const closing = new AbortController();
  const questions = new SessionQuestions(
    "claude",
    "s",
    events,
    terminal,
    () => new AbortController().signal,
    closing.signal,
  );
  expect(questions.blocksInput()).toBe(false);
  questions.configure((registry) => new ClaudeQuestionAdapter(registry));
  events.on("question", () => {
    throw new Error("consumer");
  });
  events.emit("activity", {
    elwoodSessionId: "s",
    agent: "claude",
    source: "hook",
    kind: "hook",
    label: "PreToolUse",
    raw: {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "native",
      tool_input: {
        questions: definitions.map((question) => ({
          question: question.prompt,
          header: question.header,
          options: question.options,
          multiSelect: question.selection === "multiple",
        })),
      },
    },
  });
  const native = fixture("questions");
  await terminal.writeOutput(
    `\x1b[H\x1b[2J${native.lines.join("\r\n")}\x1b[${native.cursorRow + 1};1H`,
  );
  expect(terminal.renderFailed).toBe(false);
  expect(questions.list()).toHaveLength(1);
  expect(questions.blocksInput()).toBe(true);
  questions.revoke();
  closing.abort();
  expect(questions.list()).toEqual([]);
});

test("C-QUESTION-01 shutdown retires every request despite a throwing closed observer", () => {
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, () => {});
  terminals.push(terminal);
  const events = new TypedEmitter<ElwoodCommonEventMap>();
  const closing = new AbortController();
  const questions = new SessionQuestions(
    "codex",
    "s",
    events,
    terminal,
    () => new AbortController().signal,
    closing.signal,
  );
  questions.registry.publish("one", "queued", [definitions[0]!]);
  questions.registry.publish("two", "queued", [definitions[1]!]);
  let closed = 0;
  events.on("question", (event) => {
    if (event.phase === "closed") {
      closed++;
      throw new Error("consumer");
    }
  });
  closing.abort();
  expect(closed).toBe(2);
  expect(questions.list()).toEqual([]);
});
