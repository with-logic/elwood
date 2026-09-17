/**
 * Parse-time handling for the `resume`, `interactive`, `sessions`, and `models`
 * commands: `resume` rewrites onto the run path, the others reuse the run option
 * grammar and reject the options that have no meaning for them.
 * Implements PRD §12A.7-§12A.10 and C-CLI-23 through C-CLI-26.
 */

import type { CliSubcommand } from "./command-types.ts";
import { usage } from "./request/values.ts";
import type { ParsedCliCommand, ParsedRunCommand, RunFlags, RunOptionKey } from "./types.ts";

const flagNames: Readonly<Record<RunOptionKey, string>> = {
  agent: "--agent",
  output: "--output",
  timeout: "--timeout",
  trust: "--trust",
  highTrust: "--high-trust",
  stateDir: "--state-dir",
  verbose: "--verbose",
  stream: "--stream",
  debug: "--debug",
  ignoreDefaults: "--no-defaults",
  head: "--head",
  persona: "--persona",
  model: "--model",
  reasoningEffort: "--reasoning-effort",
  claudePermissionMode: "--claude-permission-mode",
  codexSandbox: "--codex-sandbox",
  codexApprovalPolicy: "--codex-approval-policy",
  cwd: "--cwd",
  images: "--image",
  keep: "--keep",
  showSessionId: "--show-session-id",
  resume: "--resume",
  ephemeral: "--ephemeral",
};

const interactiveRejected: readonly RunOptionKey[] = [
  "stream",
  "verbose",
  "debug",
  "head",
  "timeout",
  "persona",
  "images",
  "keep",
  "showSessionId",
  "ephemeral",
  "resume",
];
const modelsRejected: readonly RunOptionKey[] = [
  "stream",
  "head",
  "persona",
  "images",
  "keep",
  "showSessionId",
  "resume",
  "ephemeral",
];
const sessionsAllowed: readonly RunOptionKey[] = ["stateDir", "output", "ignoreDefaults"];

export function parseSubcommand(
  command: CliSubcommand,
  rest: readonly string[],
  parseRun: (runArgs: readonly string[]) => ParsedCliCommand,
): ParsedCliCommand {
  const parsed = parseRun(rest);
  if (parsed.command !== "run") return parsed;
  if (command === "resume") return rewriteResume(parsed);
  if (command === "interactive") return interactiveCommand(parsed);
  rejectPositionals(parsed, command);
  const rejected =
    command === "sessions"
      ? [...parsed.explicit].filter((key) => !sessionsAllowed.includes(key))
      : modelsRejected;
  rejectExplicit(parsed, rejected, command);
  return { command, run: parsed };
}

/** `resume <id> [prompt...]` becomes exactly `run --resume <id> [prompt...]` (C-CLI-23). */
function rewriteResume(parsed: ParsedRunCommand): ParsedRunCommand {
  if (parsed.flags.resume !== undefined)
    throw usage("resume <id> cannot be combined with --resume; give the session id once.");
  const [id, ...promptWords] = parsed.promptWords;
  if (id === undefined) throw usage("resume requires a session id: elwood resume <id> [prompt...]");
  return withResume(parsed, id, promptWords);
}

function interactiveCommand(parsed: ParsedRunCommand): ParsedCliCommand {
  rejectExplicit(parsed, interactiveRejected, "interactive");
  if (parsed.flags.output !== undefined && parsed.flags.output !== "text")
    throw usage(`--output ${parsed.flags.output} cannot be combined with interactive.`);
  if (parsed.promptWords.length > 1)
    throw usage("interactive accepts at most one session id and no prompt.");
  const id = parsed.promptWords[0];
  if (id === undefined) return { command: "interactive", run: parsed };
  return { command: "interactive", run: withResume(parsed, id, []), id };
}

function withResume(
  parsed: ParsedRunCommand,
  id: string,
  promptWords: readonly string[],
): ParsedRunCommand {
  const flags: RunFlags = { ...parsed.flags, resume: id };
  return { command: "run", flags, explicit: new Set([...parsed.explicit, "resume"]), promptWords };
}

function rejectPositionals(parsed: ParsedRunCommand, command: CliSubcommand): void {
  if (parsed.promptWords.length > 0) throw usage(`${command} accepts options, not a prompt.`);
}

function rejectExplicit(
  parsed: ParsedRunCommand,
  rejected: readonly RunOptionKey[],
  command: CliSubcommand,
): void {
  const offending = rejected.filter((key) => parsed.explicit.has(key));
  if (offending.length === 0) return;
  const names = offending.map((key) => flagName(key, parsed.flags));
  throw usage(`${names.join(" and ")} cannot be combined with ${command}.`);
}

function flagName(key: RunOptionKey, flags: RunFlags): string {
  if (key === "stream" && flags.stream === false) return "--no-stream";
  if (key === "verbose" && flags.verbose === false) return "--no-verbose";
  if (key === "trust" && flags.trust === false) return "--no-trust";
  return flagNames[key];
}
