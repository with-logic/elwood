/**
 * Claude built-in and extensible tool input types.
 * Implements PRD §6.
 */

import type { PermissionUpdate } from "../permissions.ts";
import type {
  ExitPlanModeInput,
  IdInput,
  TaskGetInput,
  TaskOutputInput,
  TaskStopInput,
} from "./inputs/control.ts";
import type { ClaudeCommonHookFields } from "./names.ts";
import type { ToolHookEventName } from "./tool-events.ts";

export type { ExitPlanModeInput, IdInput } from "./inputs/control.ts";

export type BashInput = {
  readonly command: string;
  readonly description?: string;
  readonly timeout?: number;
  readonly run_in_background?: boolean;
};

export type FileInput = { readonly file_path: string };
export type ReadInput = FileInput & { readonly offset?: number; readonly limit?: number };
export type WriteInput = FileInput & { readonly content: string };
export type EditInput = FileInput & {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
};
export type GlobInput = { readonly pattern: string; readonly path?: string };
export type GrepInput = {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly output_mode?: "content" | "files_with_matches" | "count";
  readonly "-i"?: boolean;
  readonly multiline?: boolean;
};
export type WebFetchInput = { readonly url: string; readonly prompt: string };
export type WebSearchInput = {
  readonly query: string;
  readonly allowed_domains?: readonly string[];
  readonly blocked_domains?: readonly string[];
};
export type AgentInput = {
  readonly prompt: string;
  readonly description?: string;
  readonly subagent_type?: string;
  readonly model?: string;
};
export type SimplePromptInput = { readonly prompt?: string; readonly description?: string };
export type AskUserQuestionInput = {
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
    readonly multiSelect?: boolean;
  }[];
  readonly answers?: Readonly<Record<string, string>>;
};

export type KnownClaudeToolName =
  | "Agent"
  | "AskUserQuestion"
  | "Bash"
  | "CronCreate"
  | "CronDelete"
  | "CronList"
  | "Edit"
  | "EnterPlanMode"
  | "EnterWorktree"
  | "ExitPlanMode"
  | "ExitWorktree"
  | "Glob"
  | "Grep"
  | "LS"
  | "ListMcpResourcesTool"
  | "LSP"
  | "Monitor"
  | "MultiEdit"
  | "NotebookEdit"
  | "PowerShell"
  | "PushNotification"
  | "Read"
  | "ReadMcpResourceTool"
  | "RemoteTrigger"
  | "ScheduleWakeup"
  | "SendMessage"
  | "ShareOnboardingGuide"
  | "Skill"
  | "TaskCreate"
  | "TaskGet"
  | "TaskList"
  | "TaskOutput"
  | "TaskStop"
  | "TaskUpdate"
  | "TeamCreate"
  | "TeamDelete"
  | "TodoWrite"
  | "ToolSearch"
  | "WaitForMcpServers"
  | "WebFetch"
  | "WebSearch"
  | "Write";

export type UnknownClaudeToolName = `mcp__${string}` | `unknown:${string}`;
export type GenericToolInput = Readonly<Record<string, unknown>>;

export type ClaudeToolInputByName =
  | { readonly tool_name: "Agent"; readonly tool_input: AgentInput }
  | { readonly tool_name: "AskUserQuestion"; readonly tool_input: AskUserQuestionInput }
  | { readonly tool_name: "Bash"; readonly tool_input: BashInput }
  | { readonly tool_name: "CronDelete"; readonly tool_input: IdInput }
  | { readonly tool_name: "TaskGet"; readonly tool_input: TaskGetInput }
  | { readonly tool_name: "TaskOutput"; readonly tool_input: TaskOutputInput }
  | { readonly tool_name: "TaskStop"; readonly tool_input: TaskStopInput }
  | { readonly tool_name: "Edit"; readonly tool_input: EditInput }
  | { readonly tool_name: "ExitPlanMode"; readonly tool_input: ExitPlanModeInput }
  | { readonly tool_name: "Glob"; readonly tool_input: GlobInput }
  | { readonly tool_name: "Grep"; readonly tool_input: GrepInput }
  | { readonly tool_name: "PowerShell"; readonly tool_input: BashInput }
  | {
      readonly tool_name: "SendMessage" | "Skill" | "TaskCreate";
      readonly tool_input: SimplePromptInput;
    }
  | { readonly tool_name: "Read"; readonly tool_input: ReadInput }
  | { readonly tool_name: "WebFetch"; readonly tool_input: WebFetchInput }
  | { readonly tool_name: "WebSearch"; readonly tool_input: WebSearchInput }
  | { readonly tool_name: "Write"; readonly tool_input: WriteInput }
  | { readonly tool_name: GenericKnownToolName; readonly tool_input: GenericToolInput }
  | { readonly tool_name: UnknownClaudeToolName; readonly tool_input: GenericToolInput };

type GenericKnownToolName = Exclude<
  KnownClaudeToolName,
  | "Agent"
  | "AskUserQuestion"
  | "Bash"
  | "CronDelete"
  | "Edit"
  | "ExitPlanMode"
  | "Glob"
  | "Grep"
  | "PowerShell"
  | "Read"
  | "SendMessage"
  | "Skill"
  | "TaskCreate"
  | "TaskGet"
  | "TaskOutput"
  | "TaskStop"
  | "WebFetch"
  | "WebSearch"
  | "Write"
>;

export type ClaudeToolInputUpdate<Tool extends ClaudeToolInputByName = ClaudeToolInputByName> =
  Partial<Tool["tool_input"]>;

export type ClaudeToolEventFields<E extends ToolHookEventName> = E extends "PreToolUse"
  ? { readonly tool_use_id?: string }
  : E extends "PermissionRequest"
    ? { readonly permission_suggestions?: readonly PermissionUpdate[] }
    : E extends "PostToolUse"
      ? {
          readonly tool_use_id?: string;
          readonly tool_response: unknown;
          readonly duration_ms?: number;
        }
      : E extends "PostToolUseFailure"
        ? {
            readonly tool_use_id?: string;
            readonly error: string;
            readonly is_interrupt?: boolean;
            readonly duration_ms?: number;
          }
        : E extends "PermissionDenied"
          ? { readonly tool_use_id: string; readonly reason: string }
          : Record<string, never>;

export type ClaudeToolEventForName<E extends ToolHookEventName> = ClaudeCommonHookFields & {
  readonly hook_event_name: E;
} & ClaudeToolInputByName &
  ClaudeToolEventFields<E>;

export type ClaudeToolEvent = {
  readonly [E in ToolHookEventName]: ClaudeToolEventForName<E>;
}[ToolHookEventName];
