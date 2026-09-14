/**
 * Static production help for the first-party headless Elwood command.
 * Implements PRD §12A.1/§12A.7-§12A.10 and C-CLI-02/C-CLI-21 through C-CLI-26.
 */

export const cliHelp = `Usage: elwood [options] [prompt...]
       elwood run [options] [prompt...]
       elwood resume <id> [options] [prompt...]
       elwood interactive [id] [options]
       elwood sessions [--state-dir <path>] [--output <text|json>]
       elwood models [options] [--output <text|json>]
       elwood config <command>

Run one Claude Code or Codex turn and write its combined assistant response.
Positional text and piped stdin are combined with one blank line.

Examples:
  elwood "Summarize this repository"
  git diff | elwood "Review this diff for correctness"
  elwood run --output json < prompt.txt
  elwood --output json "Remember this decision"

Commands:
  run                         Run one agent turn (default)
  resume <id> [prompt...]     Resume a kept session; same as run --resume <id>
  interactive [id]            Open the agent's own TUI here with Elwood's settings
  sessions                    List Elwood-owned session records; never starts an agent
  models                      List both agents' models (starts each briefly)
  config                      Inspect or update global defaults; see config --help
  help                        Show this help

Agent and turn options:
  --agent <claude|codex>      Select the agent (default: first available of claude, codex)
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
  --keep                      Preserve Elwood state (default)
  --resume <id>               Resume the exact stored agent and workspace
  --ephemeral                 Remove new or resumed Elwood state afterward
  --output <text|json|jsonl>  Stdout protocol (default: text)
  --stream / --no-stream      Toggle incremental text output (default: off)
  --verbose / --no-verbose    Toggle warnings and concise progress on stderr (default: off)
  --debug                     Write full sanitized event details to stderr
  --head                      View the full agent TUI in this terminal
  --state-dir <path>          Override CLI-owned state storage

Agent posture defaults and supported values:
  --high-trust / --no-high-trust
                              Never ask for permissions on either agent (default: off):
                              Claude bypassPermissions; Codex danger-full-access + never
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

Resume subcommand:
  elwood resume <id> [prompt...] is exactly elwood run --resume <id>: the stored
  agent and workspace are used, --cwd is rejected, and piped stdin still applies.

Interactive mode:
  elwood interactive [id] runs claude or codex in the foreground of this terminal
  with the resolved agent, model, effort, workspace, and posture passed as the
  agent's own flags. Elwood does not observe or record the conversation and
  writes no session state. With an id, the stored session's own conversation is
  resumed in its stored workspace with its stored posture. Requires a terminal on
  stdin and stdout; cannot be combined with --output json/jsonl, --stream,
  --verbose, --debug, --head, --timeout, --persona, --image, --keep, --ephemeral,
  or --resume. Built-in posture defaults are not applied unless configured.

Session listing:
  elwood sessions lists id, agent, live, resumable, last used, created, and
  workspace for records in the effective state directory. "live" means a
  launch's bridge socket is present. Text is an aligned table; --output json
  emits one {"schemaVersion":1,"type":"sessions",...} document. An empty state
  directory is a normal, empty result.

Model listing:
  elwood models probes Claude then Codex, showing each model's agent. --agent
  limits the listing to that agent; saved/environment agent defaults do not.
  Each probe opens and cancels the picker, then removes its session state.
  Text marks current with * and default with (default); JSON emits one models
  document: agents/errors arrays for both, or agent/models with --agent.
  Partial failures retain available models and exit nonzero. --timeout is one
  budget for the whole command; Ctrl-C stops further probes. Honors --cwd,
  --model, --reasoning-effort, --state-dir, trust, and matching posture flags.

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
