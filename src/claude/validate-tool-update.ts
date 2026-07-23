/**
 * Runtime validation for Claude tool input rewrite payloads.
 *
 * Implements PRD §6.4: a returned `updatedInput` MUST be validated against the
 * actual tool input shape for known built-in tools before it is serialized to
 * Claude. `updatedInput` is a partial rewrite, so every documented field is
 * optional, but each present field must match the tool's documented value TYPE
 * (not merely be a permitted key). Unknown/MCP tools accept any record.
 */

import {
  isRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  partial,
} from "./validate-shapes.ts";

export function isClaudeToolInputUpdate(toolName: string | undefined, value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (toolName === "Agent") return isAgentUpdate(value);
  if (toolName === "AskUserQuestion") return isAskUserQuestionUpdate(value);
  if (toolName === "Bash" || toolName === "PowerShell") return isBashUpdate(value);
  if (toolName === "Edit") return isEditUpdate(value);
  if (toolName === "ExitPlanMode") return isExitPlanModeUpdate(value);
  if (toolName === "Glob") return isGlobUpdate(value);
  if (toolName === "Grep") return isGrepUpdate(value);
  if (toolName === "Read") return isReadUpdate(value);
  if (toolName === "WebFetch") return isWebFetchUpdate(value);
  if (toolName === "WebSearch") return isWebSearchUpdate(value);
  if (toolName === "Write") return isWriteUpdate(value);
  return true;
}

function isAgentUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    prompt: optionalString,
    description: optionalString,
    subagent_type: optionalString,
    model: optionalString,
  });
}

function isAskUserQuestionUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, { questions: optionalQuestions, answers: optionalAnswers });
}

function isBashUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    command: optionalString,
    description: optionalString,
    timeout: optionalNumber,
    run_in_background: optionalBoolean,
  });
}

function isEditUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    file_path: optionalString,
    old_string: optionalString,
    new_string: optionalString,
    replace_all: optionalBoolean,
  });
}

function isExitPlanModeUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    allowedPrompts: optionalStringArray,
    plan: optionalString,
    planFilePath: optionalString,
  });
}

function isGlobUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, { pattern: optionalString, path: optionalString });
}

function isGrepUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    pattern: optionalString,
    path: optionalString,
    glob: optionalString,
    output_mode: optionalOutputMode,
    "-i": optionalBoolean,
    multiline: optionalBoolean,
  });
}

function isReadUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    file_path: optionalString,
    offset: optionalNumber,
    limit: optionalNumber,
  });
}

function isWebFetchUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, { url: optionalString, prompt: optionalString });
}

function isWebSearchUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, {
    query: optionalString,
    allowed_domains: optionalStringArray,
    blocked_domains: optionalStringArray,
  });
}

function isWriteUpdate(value: Readonly<Record<string, unknown>>): boolean {
  return partial(value, { file_path: optionalString, content: optionalString });
}

function optionalOutputMode(value: unknown): boolean {
  return (
    value === undefined ||
    value === "content" ||
    value === "files_with_matches" ||
    value === "count"
  );
}

function optionalQuestions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isQuestion));
}

function isQuestion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value["question"] === "string" &&
    typeof value["header"] === "string" &&
    Array.isArray(value["options"]) &&
    value["options"].every(isQuestionOption) &&
    optionalBoolean(value["multiSelect"])
  );
}

function isQuestionOption(value: unknown): boolean {
  return (
    isRecord(value) && typeof value["label"] === "string" && optionalString(value["description"])
  );
}

function optionalAnswers(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"))
  );
}
