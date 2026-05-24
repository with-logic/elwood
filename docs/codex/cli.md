# Codex CLI Notes

Sources researched:

- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/cli/reference
- local `codex --help` and `codex --version` output

## Interactive Mode

`codex` launches an interactive full-screen terminal UI. That is the mode Elwood
must wrap. The parent app should control Codex through PTY input and observe it
through hooks, not through `codex exec`, the SDK, or app-server APIs.

Codex accepts an optional initial prompt, but Elwood starts without one by
default and sends prompts later through the terminal input path.

Useful CLI capabilities for Elwood:

- `codex` starts a new interactive session.
- `codex resume <SESSION_ID>` resumes a specific interactive session.
- `codex resume --last` resumes the most recent interactive session for the
  current working directory.
- `--cd <DIR>` tells Codex which project root to use.
- `--config key=value` applies one-off TOML configuration overrides.
- `--model <MODEL>`, `--profile <NAME>`, `--sandbox <MODE>`, and
  `--ask-for-approval <POLICY>` map naturally to adapter launch options.
- Some Codex versions expose `--dangerously-bypass-hook-trust`, which lets
  generated Elwood hooks run for one invocation without requiring a persisted
  trust prompt. Elwood must detect support before passing it because other Codex
  versions reject unknown flags.

## Resume Implications

Codex stores transcripts locally under Codex-owned state. Elwood should persist
only the Codex session id needed to call `codex resume <SESSION_ID>`. If that id
has not arrived through hooks yet, Elwood may fall back to `codex resume --last`
only when the caller explicitly accepts that behavior.

## Shell Implications

The process should still be launched from the user's normal interactive login
shell so `codex` resolution, auth environment, and user shell startup behavior
match opening Terminal.app manually.
