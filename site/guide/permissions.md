# Permissions and cleanup

Elwood starts a real coding agent. It can use that agent's tools and change your workspace according to its permissions. Choose those permissions when you launch, especially for unattended scripts.

## CLI defaults

By default neither agent stops to ask a human for approval. The two agents express that differently:

| Agent | Default CLI posture | What it means |
| --- | --- | --- |
| Claude | `--claude-permission-mode dontAsk` | Permission prompts are suppressed. A tool outside the permitted set is denied rather than asked about. |
| Codex | `--codex-sandbox workspace-write` with `--codex-approval-policy never` | `never` means never ask for approval. The sandbox additionally keeps file writes inside the workspace. |

Neither default grants every possible tool permission. A successful turn may explain that it could not perform an operation.

`--high-trust` is the agent-neutral way to say "never ask for agent permissions". For whichever agent runs it selects Claude `bypassPermissions`, or Codex `danger-full-access` with approval policy `never`, so you do not have to remember which value means what for each agent.

```sh
elwood --high-trust "Fix the failing tests and commit."
```

It layers like any other setting: `ELWOOD_HIGH_TRUST=true`, `elwood config set highTrust true`, and `--no-high-trust` to reverse an inherited value. Combining a flag or environment high trust with an explicit `--claude-permission-mode`, `--codex-sandbox`, or `--codex-approval-policy` is a usage error naming both sources, rather than a silent override. A saved per-agent posture key is overridden by high trust; a saved `highTrust` yields to an explicit per-agent flag.

High trust removes the agent's own guardrails, including Codex's workspace sandbox. Use it for work you would let run unattended, in a directory you trust. Claude shows a one-time acceptance dialog the first time a machine runs in bypass mode; Elwood answers it under the same trust automation as the workspace gate.

The CLI automates only allowlisted trust dialogs. An unhandled blocking prompt exits as `blocked_prompt`. `--no-trust` disables workspace and extension trust automation; it does not turn an unattended command into a permission UI.

```sh
elwood --agent claude --claude-permission-mode plan \
  "Propose a refactor without applying it."
```

## Library options

The library constructor accepts agent-specific settings. A narrow Claude example:

```ts
import { ClaudeSession } from "@with-logic/elwood";

const session = new ClaudeSession({
  cwd: process.cwd(),
  permissionMode: "dontAsk",
  allowedTools: ["Read", "Glob", "Grep"],
  disallowedTools: ["Write", "Edit", "Bash"],
});

try {
  console.log(await session.send("Explain the module boundaries."));
} finally {
  await session.close();
}
```

Tool rules are interpreted by the agent; this is not a filesystem sandbox supplied by Elwood. If you enable additional integrations or tools, review their capabilities too. For Codex, choose `sandbox` and `approvalPolicy` in its constructor.

## Input and authority

A piped document becomes part of the prompt. It is not automatically a trusted instruction. For jobs that process outside content, pair the task with the minimum tools and workspace access needed.

A `--persona` setting runs a real setup turn before the main prompt. Its answer is hidden, but its tool calls and file changes still happen. Use it for a deliberate setup task, not as if it were an inert label. It applies to new CLI sessions, not resume.

## Cleanup

Ephemeral CLI cleanup removes Elwood's session record and loop state. It does not revert code changes or delete agent-owned conversation history. In the library, `close()` stops the process and `teardown()` removes Elwood-owned state.

Elwood uses the agent's existing account, so normal provider usage limits and billing still apply. There is no separate Elwood model proxy.
