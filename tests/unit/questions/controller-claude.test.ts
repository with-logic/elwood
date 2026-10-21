/** Completed-render observation and observer failure containment (PRD §4). */
import { afterEach, expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodWarningEvent } from "../../../src/core/types.ts";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { definitions, fixture } from "./helpers.ts";
import { preToolUse } from "./hook-fixtures.ts";
import { nativeHook } from "./lifecycle-helpers.ts";

afterEach(disposeTerminals);
test("direct completed renders discover questions despite throwing observers", async () => {
  const { terminal, events, questions, closing } = controllerHarness();
  const warnings: ElwoodWarningEvent[] = [];
  events.on("warning", (warning) => warnings.push(warning));
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
      ?.questions.map(({ prompt, header, options, selection, textMode, supportsSecretInput }) => ({
        prompt,
        header,
        options: options.map(({ label, description }) => ({ label, description })),
        selection,
        textMode,
        supportsSecretInput,
      })),
  ).toEqual(definitions);
  expect(questions.blocksInput()).toBe(true);
  expect(warnings).toMatchObject([
    { agent: "claude", code: "question_observer_failed", phase: "question" },
  ]);
  questions.revoke();
  closing.abort();
  expect(questions.list()).toEqual([]);
  expect(warnings).toHaveLength(1);
});
