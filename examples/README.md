# Elwood Examples

## Minimal Codex Session

`minimal.ts` is intentionally tiny. It starts Codex in the current directory,
sends one prompt, prints structured activity, then stops the session. It does
not mirror the raw Codex TUI into your shell.

```sh
bun run example:minimal
```

## Full Agent Session

`full.ts` is the more complete sample. It supports Claude or Codex, custom
working directories, custom prompts, timeout control, richer event logging, and
optional process retention with `--keep`.

```sh
bun run example:full -- --agent codex --cwd . --prompt "Summarize this repo in one paragraph."
bun run example:full -- --agent claude --cwd . --prompt "Summarize this repo in one paragraph."
```

Both examples use `autotrust: true` so embedded sessions can move past known
workspace trust prompts. The package scripts run the TypeScript examples under a
small Node supervisor because `node-pty` owns real PTYs more reliably there and
the supervisor can kill the example process tree on Ctrl-C.
