/**
 * Codex built-in and extensible tool input types.
 * Implements PRD §7A.
 */

export type CodexKnownToolName = "Bash" | "apply_patch";
export type CodexUnknownToolName = `mcp__${string}` | `unknown:${string}`;

export type CodexCommandToolInput = {
  readonly command: string;
  readonly description?: string | null;
};

export type CodexGenericToolInput = Readonly<Record<string, unknown>>;

export type CodexToolEventFields =
  | {
      readonly tool_name: "Bash" | "apply_patch";
      readonly tool_input: CodexCommandToolInput;
      readonly tool_use_id?: string;
    }
  | {
      readonly tool_name: CodexUnknownToolName;
      readonly tool_input: CodexGenericToolInput;
      readonly tool_use_id?: string;
    };
