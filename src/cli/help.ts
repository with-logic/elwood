/**
 * Static production help for the first-party headless Elwood command.
 * Implements PRD §12A.1 and C-CLI-02.
 */

export const cliHelp = `Usage: elwood [options] [prompt...]
       elwood run [options] [prompt...]
       elwood config <command>

Run one Claude Code or Codex turn and write its combined assistant response.
Positional text and piped stdin are combined with one blank line.

Examples:
  elwood "Summarize this repository"
  git diff | elwood --agent claude "Review this diff for correctness"
  elwood run --output json < prompt.txt
  elwood --keep --output json "Remember this decision"

Commands:
  run                         Run one agent turn (default)
  config                      Inspect or update global defaults; see config --help
  help                        Show this help

Agent and turn options:
  --agent <codex|claude>      Select the agent (default: codex)
  --model <id>                Select or switch the model
  --reasoning-effort <level>  Claude: low|medium|high|xhigh|max
                              Codex: none|minimal|low|medium|high|xhigh|max
  --persona <prompt>          Run a real side-effect-capable setup turn; hide its answer
  -C, --cwd <path>            Workspace for a new run (default: current directory)
  --image <path>              Attach an image; repeat to preserve order
  --timeout <duration>        Bound launch, setup, and turn (default: none; ms|s|m|h)
  --trust / --no-trust        Toggle allowlisted trust automation (default: trust)
  --no-defaults               Ignore saved config and ELWOOD_* run defaults

Continuation and output:
  --keep                      Preserve Elwood state for a new session
  --resume <id>               Resume the exact stored agent and workspace
  --ephemeral                 Remove resumed Elwood state afterward
  --output <text|json|jsonl>  Stdout protocol (default: text)
  --stream / --no-stream      Toggle incremental text output (default: off)
  --verbose / --no-verbose    Toggle concise elapsed progress on stderr (default: off)
  --debug                     Write full sanitized event details to stderr
  --head                      View the full agent TUI in this terminal
  --state-dir <path>          Override CLI-owned state storage

Agent posture defaults and supported values:
  --claude-permission-mode <default|acceptEdits|plan|auto|dontAsk|bypassPermissions>
                              Default: dontAsk
  --codex-sandbox <read-only|workspace-write|danger-full-access>
                              Default: workspace-write
  --codex-approval-policy <untrusted|on-request|never>
                              Default: never

Head mode is view-only and requires terminal stdin and stderr. It cannot be
combined with stream, verbose, debug, or JSONL output. Ctrl-C still interrupts.

Warnings and diagnostics use stderr; stdout remains the selected protocol.
Use "elwood config effective" to explain resolved values and their sources.

  -h, --help                  Show this help
  -V, --version               Show the Elwood version
`;

export const cliConfigHelp = `Usage: elwood config <command> [arguments]

Inspect or update Elwood's global user configuration without starting an agent.

Commands:
  path                        Print the global config path
  show                        Print the saved configuration document
  effective [run options]     Explain resolved launch/output settings and sources
  get <key>                   Print one configured scalar
  set <key> <value>           Set one documented config key
  unset <key>                 Remove one configured key

  -h, --help                  Show this help

Examples:
  elwood config show
  elwood config effective --agent claude
  elwood config set codex.sandbox workspace-write
`;
