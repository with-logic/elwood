/**
 * What the e2e home guard (PRD §12, C-E2E-24) and the code that reads its stops share: the
 * variable listing the suite's private homes, the guard's exit status, and the stop line it
 * writes with its reason. The line ends in a token drawn once per parent process, so neither a
 * startup file nor the agent or probe command can print it, and only a shell that exited
 * `homeGuardExitCode` after writing it counts as stopped by the guard. Owned here, apart from
 * the guard script in `shell.ts`, so the probe runner and the startup check that read it never
 * load the shell helpers.
 */

import { randomBytes } from "node:crypto";

/**
 * The variable listing the e2e suite's private CLI homes as a JSON array of absolute paths,
 * each home in its given and its real spelling.
 */
export const homeGuardHomesKey = "ELWOOD_E2E_PRIVATE_HOMES";

/** The exit status of a login shell the e2e home guard stopped. */
export const homeGuardExitCode = 97;

/** The start of the line the guard writes with its reason before it exits. */
export const homeGuardStopLine = `elwood-home-guard-stopped-${randomBytes(8).toString("hex")}`;

/** Why a launch the e2e home guard stopped failed, for its start or probe error. */
export const homeGuardStoppedReason =
  "the e2e home guard stopped its login shell: a startup file left CODEX_HOME or " +
  "CLAUDE_CONFIG_DIR unexported or not one of the suite's private homes, or " +
  `${homeGuardHomesKey} is not a JSON array of absolute paths`;

/**
 * Whether a login shell that exited with `status`, and whose captured `output` is given, was
 * stopped by the e2e home guard: the status alone could be the command's own.
 */
export function homeGuardStopped(status: number | null, output: string): boolean {
  return status === homeGuardExitCode && output.includes(homeGuardStopLine);
}
