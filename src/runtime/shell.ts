/**
 * User shell helpers shared by preflight and PTY launch.
 * Implements PRD §4.2, the probe start line of §9.2 (C-PTY-08, C-PERF-05), and the e2e
 * home guard of §12 (C-E2E-24).
 */

import { userInfo } from "node:os";
import type { ElwoodAgentKind } from "../core/activity/index.ts";
import { isStringArray } from "../core/predicates.ts";
import { homeGuardExitCode, homeGuardHomesKey, homeGuardStopMarker } from "./home-guard/index.ts";
import { probeStartScript } from "./probe/start.ts";

export function userShell(): string {
  return userInfo().shell || "/bin/zsh";
}

/**
 * Quote one argument for the POSIX login shells used by both adapters: wrap in
 * single quotes, escaping embedded single quotes as '\''.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The login shell's arguments; the script to run is always the fourth. */
export type LoginShellArgs = readonly ["-l", "-i", "-c", string];

/** The interactive login shell's arguments for `script`, shared by the PTY and the probes. */
function loginShellArgs(script: string): LoginShellArgs {
  return ["-l", "-i", "-c", script];
}

/** Interactive login shell for the agent PTY — matches Terminal.app (§4.2). */
export function loginShellCommand(command: string): LoginShellArgs {
  return loginShellArgs(`${homeGuardScript("session")}${command}`);
}

/**
 * Interactive login shell for the non-PTY probes (`--version`, `update`, `--help`).
 * The same shell and flags as `loginShellCommand` (C-PTY-08): the probes and the agent
 * PTY must resolve the same CLI installation, so a probe loads the same user PATH the
 * PTY launch does. The one divergence is the start line written before the command, on the
 * runner's private control descriptor or, from a shell that closed it, on stdout, so the
 * probe runner can bound the user's profile and the CLI separately (C-PERF-05).
 */
export function probeShellCommand(command: string): LoginShellArgs {
  // The start line comes first, so the runner still tells a shell that never started the
  // probe from one the e2e home guard stopped after it (`homeGuardStopped`).
  return loginShellArgs(`${probeStartScript}${homeGuardScript("probe")}${command}`);
}

/**
 * The same login shell, for a lookup answered by its exit status alone (`command -v`). The
 * command's output goes to `/dev/null`, so the probe captures none of it.
 */
export function probeShellStatus(command: string): LoginShellArgs {
  return probeShellCommand(`${command} >/dev/null 2>&1`);
}

/** The variable naming each adapter's CLI home. */
const homeVariables = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
} as const satisfies Record<ElwoodAgentKind, string>;

type HomeVariable = (typeof homeVariables)[ElwoodAgentKind];

/**
 * Why the guard stops a launch: the list cannot be read, or a guarded variable is no longer an
 * exported, resolvable registered home (replaced, unset, unexported, or unresolvable).
 */
type Refusal =
  | { readonly kind: "unreadable_list" }
  | { readonly kind: "invalid_home"; readonly variable: HomeVariable };

function refusalReason(refusal: Refusal): string {
  switch (refusal.kind) {
    case "unreadable_list":
      return `${homeGuardHomesKey} is not a JSON array of absolute paths`;
    case "invalid_home":
      return `the login shell left ${refusal.variable} unexported or not one of the suite's private homes`;
  }
}

/** The launch a guard script stops: a session's PTY, or a probe, which has no terminal. */
type GuardedLaunch = "session" | "probe";

/**
 * Shell code that writes the stop marker with why the guard stopped the launch, and exits
 * `homeGuardExitCode`. Not on stderr, which a startup file can redirect. A session's shell
 * writes to its terminal, `/dev/tty`, which its PTY captures however the startup files
 * redirected stdin, stdout, or stderr, and falls back to stdout only if it cannot open it. A
 * probe has no terminal of its own (one opened there could be the user's), so it writes to the
 * stdout the probe runner captures.
 */
function refuse(refusal: Refusal, launch: GuardedLaunch): string {
  const line = shellQuote(`${homeGuardStopMarker}: ${refusalReason(refusal)}`);
  const write = `printf '%s\\n' ${line}`;
  const report = launch === "session" ? `{ ${write} >/dev/tty; } 2>/dev/null || ${write}` : write;
  return `{ ${report}; exit ${homeGuardExitCode}; }; `;
}

/** The registered homes, or `undefined` when `raw` is not a JSON array of absolute paths. */
function privateHomes(raw: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isStringArray(parsed) && parsed.every((home) => home.startsWith("/")) ? parsed : undefined;
}

// The real path of `$elwood_home`, resolved as the CLI will, against the shell's cwd. `builtin`
// skips a user's `cd` function or alias, an empty `CDPATH` keeps a relative name relative,
// zsh's `-q` skips `chpwd` hooks, and only `pwd` may print: a zsh `cd` can print the
// directory it changed to.
const realHome =
  `elwood_home=$(CDPATH=; if [ -n "\${ZSH_VERSION-}" ]; then builtin cd -q -P -- "$elwood_home"; ` +
  'else builtin cd -P -- "$elwood_home"; fi >/dev/null 2>&1 && builtin pwd -P)';

/**
 * The e2e suite's CLI home guard (PRD §12, C-E2E-24). The suite points `CLAUDE_CONFIG_DIR`
 * and `CODEX_HOME` at private homes it creates and lists in `ELWOOD_E2E_PRIVATE_HOMES`, but
 * each CLI starts through the user's login shell, whose startup files run after Elwood hands
 * over its environment and could replace, unset, or unexport either one. Each of the two that
 * Elwood's own environment sets to a listed home is guarded: the login shell, after its
 * startup files, exits `homeGuardExitCode` before the agent or probe command unless the
 * variable is still exported and its real path is a listed home. A list that cannot be read
 * stops every launch. With no list, as outside the suite, the script is empty. `launch` picks
 * where the guard reports a stop (`refuse`).
 */
export function homeGuardScript(launch: GuardedLaunch): string {
  const raw = process.env[homeGuardHomesKey] ?? "";
  if (raw === "") return "";
  const homes = privateHomes(raw);
  if (homes === undefined) return refuse({ kind: "unreadable_list" }, launch);
  const listed = homes.map(shellQuote).join("|");
  return Object.values(homeVariables)
    .filter((name) => homes.includes(process.env[name] ?? ""))
    .map(
      // `printenv` sees only what the shell exports, which is what the CLI inherits.
      (name) =>
        `elwood_home=$(command printenv ${name}) && ${realHome} && ` +
        `case "$elwood_home" in ${listed}) true;; *) false;; esac || ` +
        refuse({ kind: "invalid_home", variable: name }, launch),
    )
    .join("");
}
