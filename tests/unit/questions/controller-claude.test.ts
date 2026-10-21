/** Completed-render observation and observer failure containment (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { definitions, fixture } from "./helpers.ts";
import { preToolUse } from "./hook-fixtures.ts";
import { nativeHook } from "./lifecycle-helpers.ts";

afterEach(disposeTerminals);
test("direct completed renders discover questions despite throwing observers", async () => {
  const { terminal, events, questions, closing } = controllerHarness();
  expect(questions.blocksInput()).toBe(false);
  questions.configure((registry) => new ClaudeQuestionAdapter(registry));
  events.on("question", () => {
    throw new Error("consumer");
  });
  events.emit("activity", nativeHook(preToolUse.hook_event_name, preToolUse));
  const questionFrame = fixture("questions");
  await terminal.writeOutput(
    `\x1b[H\x1b[2J${questionFrame.lines.join("\r\n")}\x1b[${questionFrame.cursorRow + 1};1H`,
  );
  expect(terminal.renderFailed).toBe(false);
  expect(questions.list()).toHaveLength(1);
  expect(
    questions
      .list()[0]
      ?.questions.map(({ prompt, header, options, selection, textMode, secret }) => ({
        prompt,
        header,
        options: options.map(({ label, description }) => ({ label, description })),
        selection,
        textMode,
        secret,
      })),
  ).toEqual(definitions);
  expect(questions.blocksInput()).toBe(true);
  questions.revoke();
  closing.abort();
  expect(questions.list()).toEqual([]);
});
