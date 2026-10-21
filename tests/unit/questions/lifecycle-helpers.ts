/** Native hook and fenced-composer fixtures for Claude lifecycle regressions (PRD §4). */
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { definitions, frame } from "./helpers.ts";
export const nativeQuestions = definitions.map((question) => ({
  question: question.prompt,
  header: question.header,
  options: question.options,
  multiSelect: question.selection === "multiple",
}));
export function nativeHook(
  name = "PreToolUse",
  extra: Readonly<Record<string, unknown>> = {},
): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s",
    agent: "claude",
    source: "hook",
    kind: "hook",
    label: name,
    raw: {
      hook_event_name: name,
      tool_name: "AskUserQuestion",
      tool_use_id: "native",
      tool_input: { questions: nativeQuestions },
      ...extra,
    },
  };
}
export function composer() {
  return {
    ...frame("Claude Code v2.1.305\n────\n❯ \n────\n⏸ manual mode on · ? for shortcuts"),
    cursorX: 2,
    cursorVisible: true,
  };
}
