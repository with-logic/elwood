# Elwood Examples

## Minimal Agent Session

`minimal.ts` starts one real Claude or Codex session, sends one prompt, prints
the unified activity stream, then stops the session.

```sh
bun examples/minimal.ts --agent codex --cwd . --prompt "Summarize this repo in one paragraph."
```

Use Claude instead:

```sh
bun examples/minimal.ts --agent claude --cwd . --prompt "Summarize this repo in one paragraph."
```

The example uses `autotrust: true` so embedded sessions can move past known
workspace trust prompts. Pass `--keep` to leave the agent process running after
the prompt settles.
