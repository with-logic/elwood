/** Valid Claude question hook variants for lifecycle unit tests (PRD §6). */
import type { ClaudeHookEvent, ClaudeHookEventFor } from "../../../src/claude/hooks/events.ts";
import { isClaudeHookInput } from "../../../src/claude/validate/input.ts";
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { definitions } from "./helpers.ts";

const envelope = { session_id: "s", cwd: "/project" } as const;
const tool = {
  ...envelope,
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: definitions.map((question) => {
      if (question.header === undefined) throw new Error("Question fixture needs a header");
      return {
        question: question.prompt,
        header: question.header,
        options: question.options,
        multiSelect: question.selection === "multiple",
      };
    }),
  },
} as const;
export const preToolUse = {
  ...tool,
  hook_event_name: "PreToolUse",
  tool_use_id: "native",
} satisfies ClaudeHookEventFor<"PreToolUse">;
export const permissionRequest = {
  ...tool,
  hook_event_name: "PermissionRequest",
} satisfies ClaudeHookEventFor<"PermissionRequest">;
export const postToolUse = {
  ...tool,
  hook_event_name: "PostToolUse",
  tool_use_id: "native",
  tool_response: { answers: {} },
} satisfies ClaudeHookEventFor<"PostToolUse">;
export const postToolUseFailure = {
  ...tool,
  hook_event_name: "PostToolUseFailure",
  tool_use_id: "native",
  error: "Question interrupted",
  is_interrupt: true,
} satisfies ClaudeHookEventFor<"PostToolUseFailure">;
export const permissionDenied = {
  ...tool,
  hook_event_name: "PermissionDenied",
  tool_use_id: "native",
  reason: "Question denied",
} satisfies ClaudeHookEventFor<"PermissionDenied">;
export const notification = {
  ...envelope,
  hook_event_name: "Notification",
  message: "Unrelated notification",
  notification_type: "idle_prompt",
} satisfies ClaudeHookEventFor<"Notification">;
export const stop = {
  ...envelope,
  hook_event_name: "Stop",
} satisfies ClaudeHookEventFor<"Stop">;

/** Build activity only from a complete, runtime-validated native hook fixture. */
export function validatedHookActivity(raw: ClaudeHookEvent): ElwoodActivityEvent {
  if (!isClaudeHookInput(raw)) throw new Error("Hook fixture must pass input validation");
  return {
    elwoodSessionId: "s",
    agent: "claude",
    source: "hook",
    kind: "hook",
    label: raw.hook_event_name,
    raw,
  };
}
