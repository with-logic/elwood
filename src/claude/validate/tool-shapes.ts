/**
 * Exhaustive concrete Claude tool schemas shared by ingress and rewrites.
 * Implements PRD §6.4; generic and future tools deliberately retain record inputs.
 */

import { isRecord, isString } from "../../core/predicates.ts";
import type { ClaudeToolInputByName, KnownClaudeToolName } from "../hooks/tool-types.ts";
import {
  type FieldChecks,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
} from "./shapes.ts";
import {
  isQuestions,
  optionalAllowedPrompts,
  optionalAnswers,
  optionalOutputMode,
} from "./tool-values.ts";

type InputFor<Name extends KnownClaudeToolName> = (ClaudeToolInputByName & {
  readonly tool_name: Name;
})["tool_input"];
type ConcreteToolName = {
  [Name in KnownClaudeToolName]: string extends keyof InputFor<Name> ? never : Name;
}[KnownClaudeToolName];
type ToolSchemas = { readonly [Name in ConcreteToolName]: FieldChecks<InputFor<Name>> };

const shell = {
  command: isString,
  description: optionalString,
  timeout: optionalNumber,
  run_in_background: optionalBoolean,
};
const id = { id: isString };
const prompt = { prompt: optionalString, description: optionalString };

export const claudeToolSchemas = {
  Agent: {
    prompt: isString,
    description: optionalString,
    subagent_type: optionalString,
    model: optionalString,
  },
  AskUserQuestion: { questions: isQuestions, answers: optionalAnswers },
  Bash: shell,
  PowerShell: shell,
  CronDelete: id,
  TaskGet: { taskId: isString },
  TaskOutput: {
    task_id: isString,
    block: (value) => typeof value === "boolean",
    timeout: (value) => typeof value === "number",
  },
  TaskStop: { task_id: optionalString, shell_id: optionalString },
  SendMessage: prompt,
  Skill: prompt,
  TaskCreate: prompt,
  Edit: {
    file_path: isString,
    old_string: isString,
    new_string: isString,
    replace_all: optionalBoolean,
  },
  ExitPlanMode: {
    allowedPrompts: optionalAllowedPrompts,
    plan: optionalString,
    planFilePath: optionalString,
  },
  Glob: { pattern: isString, path: optionalString },
  Grep: {
    pattern: isString,
    path: optionalString,
    glob: optionalString,
    output_mode: optionalOutputMode,
    "-i": optionalBoolean,
    multiline: optionalBoolean,
  },
  Read: { file_path: isString, offset: optionalNumber, limit: optionalNumber },
  WebFetch: { url: isString, prompt: isString },
  WebSearch: {
    query: isString,
    allowed_domains: optionalStringArray,
    blocked_domains: optionalStringArray,
  },
  Write: { file_path: isString, content: isString },
} satisfies ToolSchemas;

export function toolSchema(
  name: string,
): FieldChecks<Readonly<Record<string, unknown>>> | undefined {
  return Object.hasOwn(claudeToolSchemas, name)
    ? claudeToolSchemas[name as ConcreteToolName]
    : undefined;
}

export function isClaudeToolInput(toolName: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const checks = toolSchema(toolName);
  // Future input fields are retained, but every declared field must match its type.
  return checks === undefined || Object.entries(checks).every(([key, check]) => check(value[key]));
}
