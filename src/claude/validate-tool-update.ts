/**
 * Runtime validation for Claude tool input rewrite payloads.
 *
 * Implements PRD §6.4: a returned `updatedInput` MUST be validated against the
 * actual tool input shape for known built-in tools before it is serialized to
 * Claude. `updatedInput` is a partial rewrite, so every documented field is
 * optional, but each present field must match the tool's documented value TYPE
 * (not merely be a permitted key). Unknown/MCP tools accept any record.
 *
 * Each per-tool table is `satisfies FieldChecks<Input>`, so adding a field to the
 * public tool input type forces a matching check here (a missing key fails to
 * compile) — the validator can no longer silently drift from the shape it guards.
 */

import type {
  AgentInput,
  AskUserQuestionInput,
  BashInput,
  EditInput,
  ExitPlanModeInput,
  GlobInput,
  GrepInput,
  ReadInput,
  WebFetchInput,
  WebSearchInput,
  WriteInput,
} from "./tool-types.ts";
import {
  type FieldCheck,
  type FieldChecks,
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
  // An unknown/MCP tool (or absent name) has no table, so it accepts any record.
  const checks = toolChecks[toolName ?? ""];
  return checks === undefined ? true : partial(value, checks);
}

const agentChecks = {
  prompt: optionalString,
  description: optionalString,
  subagent_type: optionalString,
  model: optionalString,
} satisfies FieldChecks<AgentInput>;

const askUserQuestionChecks = {
  questions: optionalQuestions,
  answers: optionalAnswers,
} satisfies FieldChecks<AskUserQuestionInput>;

// Shared by the Bash AND PowerShell tools (same documented BashInput shape).
const shellChecks = {
  command: optionalString,
  description: optionalString,
  timeout: optionalNumber,
  run_in_background: optionalBoolean,
} satisfies FieldChecks<BashInput>;

const editChecks = {
  file_path: optionalString,
  old_string: optionalString,
  new_string: optionalString,
  replace_all: optionalBoolean,
} satisfies FieldChecks<EditInput>;

const exitPlanModeChecks = {
  allowedPrompts: optionalStringArray,
  plan: optionalString,
  planFilePath: optionalString,
} satisfies FieldChecks<ExitPlanModeInput>;

const globChecks = {
  pattern: optionalString,
  path: optionalString,
} satisfies FieldChecks<GlobInput>;

const grepChecks = {
  pattern: optionalString,
  path: optionalString,
  glob: optionalString,
  output_mode: optionalOutputMode,
  "-i": optionalBoolean,
  multiline: optionalBoolean,
} satisfies FieldChecks<GrepInput>;

const readChecks = {
  file_path: optionalString,
  offset: optionalNumber,
  limit: optionalNumber,
} satisfies FieldChecks<ReadInput>;

const webFetchChecks = {
  url: optionalString,
  prompt: optionalString,
} satisfies FieldChecks<WebFetchInput>;

const webSearchChecks = {
  query: optionalString,
  allowed_domains: optionalStringArray,
  blocked_domains: optionalStringArray,
} satisfies FieldChecks<WebSearchInput>;

const writeChecks = {
  file_path: optionalString,
  content: optionalString,
} satisfies FieldChecks<WriteInput>;

/** Maps each known built-in tool name to its field-check table; others accept any record. */
const toolChecks: Readonly<Record<string, Readonly<Record<string, FieldCheck>>>> = {
  Agent: agentChecks,
  AskUserQuestion: askUserQuestionChecks,
  Bash: shellChecks,
  PowerShell: shellChecks,
  Edit: editChecks,
  ExitPlanMode: exitPlanModeChecks,
  Glob: globChecks,
  Grep: grepChecks,
  Read: readChecks,
  WebFetch: webFetchChecks,
  WebSearch: webSearchChecks,
  Write: writeChecks,
};

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
