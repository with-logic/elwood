/**
 * Parses Elwood's hybrid direct/explicit command grammar without side effects.
 * Implements PRD §12A.1 and C-CLI-02/C-CLI-04/C-CLI-06.
 */

import { parseArgs } from "node:util";
import {
  CliValidationError,
  type ParsedCliCommand,
  type RunFlags,
  type RunOptionKey,
} from "./types.ts";

const options = {
  agent: { type: "string" },
  output: { type: "string" },
  timeout: { type: "string" },
  trust: { type: "boolean" },
  "no-trust": { type: "boolean" },
  "state-dir": { type: "string" },
  verbose: { type: "boolean" },
  stream: { type: "boolean" },
  head: { type: "boolean" },
  persona: { type: "string" },
  model: { type: "string" },
  "reasoning-effort": { type: "string" },
  "claude-permission-mode": { type: "string" },
  "codex-sandbox": { type: "string" },
  "codex-approval-policy": { type: "string" },
  cwd: { type: "string", short: "C" },
  image: { type: "string", multiple: true },
  keep: { type: "boolean" },
  resume: { type: "string" },
  ephemeral: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

const optionKeys: Readonly<Record<string, RunOptionKey | undefined>> = {
  agent: "agent",
  output: "output",
  timeout: "timeout",
  trust: "trust",
  "no-trust": "trust",
  "state-dir": "stateDir",
  verbose: "verbose",
  stream: "stream",
  head: "head",
  persona: "persona",
  model: "model",
  "reasoning-effort": "reasoningEffort",
  "claude-permission-mode": "claudePermissionMode",
  "codex-sandbox": "codexSandbox",
  "codex-approval-policy": "codexApprovalPolicy",
  cwd: "cwd",
  image: "images",
  keep: "keep",
  resume: "resume",
  ephemeral: "ephemeral",
};

export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  if (argv.length === 0) return { command: "help" };
  if (argv[0] === "help") return { command: "help" };
  if (argv[0] === "config") return { command: "config", args: argv.slice(1) };
  const runArgs = argv[0] === "run" ? argv.slice(1) : argv;
  try {
    const parsed = parseArgs({
      args: runArgs,
      options,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
    if (parsed.values.help === true) return { command: "help" };
    if (parsed.values.version === true) return { command: "version" };
    if (parsed.values.trust === true && parsed.values["no-trust"] === true) {
      throw new CliValidationError(
        "invalid_arguments",
        "--trust and --no-trust cannot be combined.",
      );
    }
    return {
      command: "run",
      flags: flagsFrom(parsed.values),
      explicit: explicitOptions(parsed.tokens),
      promptWords: parsed.positionals,
    };
  } catch (error) {
    if (error instanceof CliValidationError) throw error;
    throw new CliValidationError("invalid_arguments", String(error));
  }
}

function flagsFrom(values: Readonly<Record<string, unknown>>): RunFlags {
  return {
    ...(typeof values["agent"] === "string" && { agent: values["agent"] }),
    ...(typeof values["output"] === "string" && { output: values["output"] }),
    ...(typeof values["timeout"] === "string" && { timeout: values["timeout"] }),
    ...(values["trust"] === true && { trust: true }),
    ...(values["no-trust"] === true && { trust: false }),
    ...(typeof values["state-dir"] === "string" && { stateDir: values["state-dir"] }),
    ...(values["verbose"] === true && { verbose: true }),
    ...(values["stream"] === true && { stream: true }),
    ...(values["head"] === true && { head: true }),
    ...(typeof values["persona"] === "string" && { persona: values["persona"] }),
    ...(typeof values["model"] === "string" && { model: values["model"] }),
    ...(typeof values["reasoning-effort"] === "string" && {
      reasoningEffort: values["reasoning-effort"],
    }),
    ...(typeof values["claude-permission-mode"] === "string" && {
      claudePermissionMode: values["claude-permission-mode"],
    }),
    ...(typeof values["codex-sandbox"] === "string" && { codexSandbox: values["codex-sandbox"] }),
    ...(typeof values["codex-approval-policy"] === "string" && {
      codexApprovalPolicy: values["codex-approval-policy"],
    }),
    ...(typeof values["cwd"] === "string" && { cwd: values["cwd"] }),
    images: Array.isArray(values["image"]) ? (values["image"] as string[]) : [],
    ...(values["keep"] === true && { keep: true }),
    ...(typeof values["resume"] === "string" && { resume: values["resume"] }),
    ...(values["ephemeral"] === true && { ephemeral: true }),
  };
}

function explicitOptions(
  tokens: readonly { readonly kind: string; readonly name?: string }[],
): ReadonlySet<RunOptionKey> {
  const explicit = new Set<RunOptionKey>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === undefined) continue;
    explicit.add(optionKeys[token.name] as RunOptionKey);
  }
  return explicit;
}
