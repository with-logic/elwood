# Troubleshooting

Start with the smallest reproducible command in the same directory as the failing run:

```sh
elwood --no-defaults --agent claude --verbose --timeout 2m \
  "Reply with one short sentence."
```

This makes the agent, deadline and diagnostic output explicit. It still starts a real turn and uses your agent account.

## Command not found

For `elwood`, confirm the package installed successfully and that your shell can find npm's global executables. Open a fresh terminal after changing PATH. For local dependency installs, use `npx elwood --help` from that project rather than expecting a global command.

For `claude_not_found` or `codex_not_found`, run the selected agent's `--version` command. Elwood needs the actual CLI binary, not only a browser account or desktop app. Install the matching CLI, then retry from the same shell.

## Authentication fails

Run `claude` or `codex` directly and complete its sign-in flow. A CLI that is logged out cannot be made authenticated by changing Elwood's output format. Claude's [authentication guide](https://code.claude.com/docs/en/authentication) covers account and organization setup.

A different environment can select different credentials. Check how your script is launched and what environment it inherits. Keep credentials out of copied diagnostics.

## Nothing appears for a while

Text output normally waits for the combined reply. Add `--verbose` for elapsed progress or `--stream` for incremental assistant text. If you need the actual TUI, try `--head` in a terminal without incompatible stream/verbose/debug/JSONL flags.

If the agent itself is not ready, run it directly in the workspace to complete first-run setup or inspect a pending dialog. Elwood does not use raw terminal text as a fallback answer.

## A prompt is blocked

`blocked_prompt` means the unattended CLI encountered a recognized prompt it could not safely answer. Run the agent directly to understand what it needs. Adjust the intended permission or workspace setup, then retry. `--no-trust` can deliberately leave workspace trust unresolved; it does not provide an interactive prompt handler.

If a tool was denied but the agent still replied, review the permission mode and allowed tools. `dontAsk` is not a blanket grant. [Read the permissions guide](permissions.html).

## A script says success but the agent failed

Check whether your pipeline discarded Elwood's exit code. In Bash/Zsh, enable `set -o pipefail`. For JSON, require `type == "result"`; error documents can contain a partial `response`. [Use the complete JSON recipe](recipes.html#json-output-with-failure-handling).

## Timeout or a turn that will not finish

The CLI's `--timeout` bounds launch and the requested turn. Library `timeoutMs` bounds the turn wait and does not stop the process by itself. In TypeScript, close the session in `finally`, or interrupt intentionally before a follow-up.

Inspect agent progress before increasing a timeout: a blocked login or permission prompt is different from a long-running task.

## A saved conversation cannot resume

Use the Elwood session ID from a kept run and the same state directory. A provider conversation ID is not an Elwood ID. Resume restores the stored agent/workspace; do not supply a conflicting agent or `--cwd`.

`state_not_found` means the record is unavailable at the selected location. `resume_unavailable` means there is not enough provider resume information. Start a new conversation when the required state is gone; do not edit saved IDs by hand.

## Native dependency or platform error

The initial support target is macOS with Node.js 24+. Elwood uses a native PTY dependency. If installation reports native compilation errors, retain that installer output and check the Node version and local build-tool setup. Browser runtimes and unsupported operating systems are not equivalent substitutes for the supported runtime.

## Filing an issue

Include the Elwood, Node and agent versions, macOS version, the command with private input removed, exit code, error code/message, and whether the agent works directly. `elwood config effective` can explain unexpected settings. Review diagnostic output before sharing it; `--debug` includes detailed normalized events and can reveal prompt or project content.
