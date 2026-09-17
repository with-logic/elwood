/**
 * Concrete input examples for Claude boundary tests (PRD §6.4).
 * Task/plan shapes follow https://code.claude.com/docs/en/agent-sdk/typescript#tool-input-types.
 */

export const concreteInputs = {
  Agent: { prompt: "work", description: "task", subagent_type: "test", model: "model" },
  AskUserQuestion: {
    questions: [
      {
        question: "Q?",
        header: "H",
        options: [{ label: "A", description: "a" }],
        multiSelect: false,
      },
    ],
    answers: { Q: "A" },
  },
  Bash: { command: "echo ok", description: "shell", timeout: 10, run_in_background: false },
  PowerShell: { command: "echo ok", description: "shell", timeout: 10, run_in_background: true },
  CronDelete: { id: "cron" },
  TaskGet: { taskId: "task" },
  TaskOutput: { task_id: "task", block: true, timeout: 1000 },
  TaskStop: { task_id: "task", shell_id: "legacy" },
  SendMessage: { prompt: "hi", description: "message" },
  Skill: { prompt: "help", description: "skill" },
  TaskCreate: { prompt: "work", description: "task" },
  Edit: { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: false },
  ExitPlanMode: {
    allowedPrompts: [{ tool: "Bash", prompt: "build" }],
    plan: "steps",
    planFilePath: "plan.md",
  },
  Glob: { pattern: "*.ts", path: "src" },
  Grep: {
    pattern: "x",
    path: "src",
    glob: "*.ts",
    output_mode: "count",
    "-i": true,
    multiline: true,
  },
  Read: { file_path: "a.ts", offset: 0, limit: 5 },
  WebFetch: { url: "https://example.test", prompt: "read" },
  WebSearch: { query: "docs", allowed_domains: ["example.test"], blocked_domains: ["other.test"] },
  Write: { file_path: "a.ts", content: "code" },
} as const;

export const requiredInputs: Readonly<Record<keyof typeof concreteInputs, readonly string[]>> = {
  Agent: ["prompt"],
  AskUserQuestion: ["questions"],
  Bash: ["command"],
  PowerShell: ["command"],
  CronDelete: ["id"],
  TaskGet: ["taskId"],
  TaskOutput: ["task_id", "block", "timeout"],
  TaskStop: [],
  SendMessage: [],
  Skill: [],
  TaskCreate: [],
  Edit: ["file_path", "old_string", "new_string"],
  ExitPlanMode: [],
  Glob: ["pattern"],
  Grep: ["pattern"],
  Read: ["file_path"],
  WebFetch: ["url", "prompt"],
  WebSearch: ["query"],
  Write: ["file_path", "content"],
};
