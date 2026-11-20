# Configuration

The CLI resolves settings in this order: **command flags → environment → global configuration → built-in defaults**. You can inspect the result before starting an agent.

```sh
elwood config effective --agent claude --output json
```

The output includes each value and its source. This command does not read a prompt or launch an agent.

## The config file

```sh
elwood config set agent claude
elwood config set timeout 10m
elwood config set output text
elwood config show
```

`show` prints the saved document, while `effective` shows resolved settings. Remove a saved value with `unset`:

```sh
elwood config get agent
elwood config unset timeout
elwood config path
```

Configuration is global. Elwood does not read a config file from the repository being opened.

## Location and precedence

The config path is selected from `ELWOOD_CONFIG`, then an absolute `XDG_CONFIG_HOME` plus `/elwood/config.json`, then `~/.config/elwood/config.json`. Use `elwood config path` rather than guessing on a particular machine.

The configuration document has `schemaVersion: 1`. Unknown keys and values with the wrong type are rejected.

| Setting | Example value |
| --- | --- |
| `agent` | `claude` or `codex` |
| `output` | `text`, `json`, `jsonl` |
| `timeout` | `10m` |
| `trust`, `highTrust`, `verbose`, `stream` | `true` or `false` |
| `stateDir` | Absolute path to CLI-owned session state |
| `persona` | Setup prompt for new sessions |
| `claude.model`, `codex.model` | Model identifier supported by that agent |
| `claude.reasoningEffort`, `codex.reasoningEffort` | Supported effort level for that agent |
| `claude.permissionMode` | For example, `dontAsk` |
| `codex.sandbox` | For example, `workspace-write` |
| `codex.approvalPolicy` | For example, `never` |

## Environment variables

The run-setting variables are `ELWOOD_AGENT`, `ELWOOD_OUTPUT`, `ELWOOD_TIMEOUT`, `ELWOOD_TRUST`, `ELWOOD_HIGH_TRUST`, `ELWOOD_STATE_DIR`, `ELWOOD_VERBOSE`, `ELWOOD_STREAM`, `ELWOOD_PERSONA`, `ELWOOD_MODEL`, `ELWOOD_REASONING_EFFORT`, `ELWOOD_CLAUDE_PERMISSION_MODE`, `ELWOOD_CODEX_SANDBOX`, and `ELWOOD_CODEX_APPROVAL_POLICY`.

Boolean values are exactly `true` or `false`. An explicit flag overrides an environment value. `--no-stream` and `--no-verbose` override inherited true values.

```sh
ELWOOD_AGENT=claude elwood "Explain the test setup."
elwood --no-defaults --agent claude --output json "Explain the test setup."
```

`--no-defaults` ignores saved config and Elwood's run-setting variables. It does not remove credentials, PATH, or other ordinary environment used by the agent process.

## Library options

These global defaults belong to the `elwood` executable. In TypeScript, use explicit constructor and turn options. Do not assume changing `elwood config` changes a `ClaudeSession` created by your app.

```ts
const session = new ClaudeSession({
  cwd: process.cwd(),
  permissionMode: "dontAsk",
});
```

[See the constructor reference](api.html#constructor-options) or [choose permissions](permissions.html).
