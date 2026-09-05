/**
 * Static production help for the first-party headless Elwood command.
 * Implements PRD §12A.1 and C-CLI-02.
 */

export const cliHelp = `Usage: elwood [options] [prompt...]
       elwood run [options] [prompt...]
       elwood config <path|show|get|set|unset>

Run one headless Claude Code or Codex turn. Codex is the default agent.
Positional text and piped stdin are combined with a blank line.

Commands:
  run                         Run one agent turn (default)
  config path                 Print the global config path
  config show                 Print effective stored config JSON
  config get <key>            Print one configured scalar
  config set <key> <value>    Set one documented config key
  config unset <key>          Remove one configured key
  help                        Show this help

Agent and turn options:
  --agent <codex|claude>      Select the agent (default: codex)
  --model <id>                Select or switch the model
  --reasoning-effort <level>  Select reasoning effort
  --persona <prompt>          Run a discarded setup turn for a new session
  -C, --cwd <path>            Workspace directory (default: current directory)
  --image <path>              Attach an image; repeat to preserve order
  --timeout <duration>        Bound launch, setup, and turn (ms, s, m, h)
  --trust / --no-trust        Enable or disable allowlisted trust automation

Continuation and output:
  --keep                      Preserve a new session and report its ID
  --resume <id>               Resume the stored agent and workspace exactly
  --ephemeral                 Tear down a resumed session afterward
  --output <text|json|jsonl>  Select stdout protocol (default: text)
  --head                      Mirror the full agent TUI in this terminal
  --stream                    Stream assistant messages in text mode
  --verbose                   Write sanitized progress to stderr
  --state-dir <path>          Override CLI-owned state storage

Agent posture:
  --claude-permission-mode <mode>
  --codex-sandbox <mode>
  --codex-approval-policy <policy>

  -h, --help                  Show this help
  -V, --version               Show the Elwood version
`;
