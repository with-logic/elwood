/**
 * Validates every typed optional Claude event field before handlers see it.
 * Implements PRD §6.4, including nested Stop/SubagentStop task and cron records.
 */

import { isRecord, isString } from "../../core/predicates.ts";
import type {
  ClaudeBackgroundTask,
  ClaudeHookEventFor,
  ClaudeSessionCron,
  ClaudeStopFields,
} from "../hooks/events.ts";
import type { ClaudeCommonHookFields, ClaudeHookEventName } from "../hooks/names.ts";
import { isPermissionUpdateArray } from "./permission-update.ts";
import {
  type FieldCheck,
  type FieldChecks,
  optionalBoolean,
  optionalFiniteNumber,
  optionalString,
  optionalStringArray,
} from "./shapes.ts";

type Declared<T> = { [K in keyof T as string extends K ? never : K]: T[K] };
type EventFields<T> = Omit<Declared<T>, keyof Declared<ClaudeCommonHookFields>>;
type OptionalFields<T> = {
  [K in keyof T as object extends Pick<T, K> ? K : never]: T[K];
};
type EventSchemas = {
  readonly [E in ClaudeHookEventName]: FieldChecks<
    OptionalFields<EventFields<ClaudeHookEventFor<E>>>
  >;
};

const backgroundTask = {
  id: isString,
  type: isString,
  status: isString,
  description: optionalString,
  command: optionalString,
  agent_type: optionalString,
  server: optionalString,
  tool: optionalString,
  name: optionalString,
} satisfies FieldChecks<ClaudeBackgroundTask>;
const cron = {
  id: isString,
  schedule: isString,
  recurring: (value) => typeof value === "boolean",
  prompt: isString,
} satisfies FieldChecks<ClaudeSessionCron>;
const stop = {
  stop_hook_active: optionalBoolean,
  last_assistant_message: optionalString,
  background_tasks: (value) => optionalRecords(value, backgroundTask),
  session_crons: (value) => optionalRecords(value, cron),
} satisfies FieldChecks<ClaudeStopFields>;
const task = {
  task_description: optionalString,
  teammate_name: optionalString,
  team_name: optionalString,
};
/** StopFailure identity survives diagnostic schema drift (PRD §6.1). */
const anyValue: FieldCheck = () => true;

const schemas = {
  SessionStart: { model: optionalString, agent_type: optionalString },
  Setup: {},
  InstructionsLoaded: {
    globs: optionalStringArray,
    trigger_file_path: optionalString,
    parent_file_path: optionalString,
  },
  UserPromptSubmit: {},
  UserPromptExpansion: { command_args: optionalString, command_source: optionalString },
  PreToolUse: { tool_use_id: optionalString },
  PermissionRequest: {
    permission_suggestions: (value) => value === undefined || isPermissionUpdateArray(value),
  },
  PostToolUse: { tool_use_id: optionalString, duration_ms: optionalFiniteNumber },
  PostToolUseFailure: {
    tool_use_id: optionalString,
    is_interrupt: optionalBoolean,
    duration_ms: optionalFiniteNumber,
  },
  PostToolBatch: {},
  PermissionDenied: {},
  Notification: { title: optionalString },
  SubagentStart: {},
  SubagentStop: stop,
  TaskCreated: task,
  TaskCompleted: task,
  Stop: stop,
  StopFailure: { error: anyValue, error_details: anyValue, last_assistant_message: anyValue },
  TeammateIdle: {},
  ConfigChange: { file_path: optionalString },
  CwdChanged: {},
  FileChanged: {},
  WorktreeCreate: {},
  WorktreeRemove: {},
  PreCompact: { custom_instructions: (value) => value === null || optionalString(value) },
  PostCompact: {},
  SessionEnd: {},
  Elicitation: {
    mode: optionalString,
    url: optionalString,
    elicitation_id: optionalString,
    requested_schema: optionalRecord,
  },
  ElicitationResult: {
    mode: optionalString,
    elicitation_id: optionalString,
    content: optionalRecord,
  },
} satisfies EventSchemas;

export function hasOptionalEventFields(value: Readonly<Record<string, unknown>>): boolean {
  const name = value["hook_event_name"] as string;
  return (
    !Object.hasOwn(schemas, name) || matchesFields(value, schemas[name as ClaudeHookEventName])
  );
}

function matchesFields(
  value: Readonly<Record<string, unknown>>,
  checks: Readonly<Record<string, FieldCheck>>,
): boolean {
  return Object.entries(checks).every(([key, check]) => check(value[key]));
}

function optionalRecords(value: unknown, checks: Readonly<Record<string, FieldCheck>>): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((entry) => isRecord(entry) && matchesFields(entry, checks)))
  );
}

function optionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}
