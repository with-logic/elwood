/**
 * What the e2e home guard (PRD §12, C-E2E-24) and the code that reads its stops share: the
 * variable listing the suite's private homes, which home variables the guard checks, the
 * guard's exit status, and the marker that starts the line it writes, followed by its reason.
 * The marker ends in a token drawn once per parent process, so neither a startup file nor the
 * agent or probe command can print it, and only a shell that exited `homeGuardExitCode` after
 * writing it counts as stopped by the guard. Owned here, apart from the guard script in
 * `shell.ts`, so the probe runner and the startup check that read it never load the shell
 * helpers.
 */

import { randomBytes } from "node:crypto";
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { isStringArray } from "../../core/predicates.ts";
import { StreamMarkerWatcher } from "../stream-marker.ts";

/**
 * The variable listing the e2e suite's private CLI homes as a JSON array of absolute paths,
 * each home in its given and its real spelling.
 */
export const homeGuardHomesKey = "ELWOOD_E2E_PRIVATE_HOMES";

/** The exit status of a login shell the e2e home guard stopped. */
export const homeGuardExitCode = 97;

/** The marker that starts the line the guard writes, before its reason, as it exits. */
export const homeGuardStopMarker = `elwood-home-guard-stopped-${randomBytes(8).toString("hex")}`;

/** Why a launch the e2e home guard stopped failed, for its start or probe error. */
export const homeGuardStoppedReason =
  "the e2e home guard stopped its login shell: a startup file left CODEX_HOME or " +
  "CLAUDE_CONFIG_DIR unexported or not one of the suite's private homes, or " +
  `${homeGuardHomesKey} is not a JSON array of absolute paths`;

/** The variable naming each adapter's CLI home. */
const homeVariables = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
} as const satisfies Record<ElwoodAgentKind, string>;

export type HomeVariable = (typeof homeVariables)[ElwoodAgentKind];

/** The registered homes, or `undefined` when `raw` is not a JSON array of absolute paths. */
export function privateHomes(raw: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isStringArray(parsed) && parsed.every((home) => home.startsWith("/")) ? parsed : undefined;
}

/** The home variables the guard checks: those Elwood's own environment sets to one of `homes`. */
export function guardedVariables(homes: readonly string[]): readonly HomeVariable[] {
  return Object.values(homeVariables).filter((name) => homes.includes(process.env[name] ?? ""));
}

/**
 * Whether the guard checks a launch Elwood starts now, so that it can stop it and write the
 * stop marker: the list is set, and either cannot be read, which stops every launch, or names a
 * home that a guarded variable is set to.
 */
export function homeGuardChecksLaunch(): boolean {
  const raw = process.env[homeGuardHomesKey] ?? "";
  if (raw === "") return false;
  const homes = privateHomes(raw);
  return homes === undefined || guardedVariables(homes).length > 0;
}

/**
 * Whether a login shell that exited with `status` was stopped by the e2e home guard: only if
 * its output also carried the stop marker (`sawMarker`, asked only after a status-97 exit),
 * since the status alone could be the command's own.
 */
export function homeGuardStopped(status: number | null, sawMarker: () => boolean): boolean {
  return status === homeGuardExitCode && sawMarker();
}

const stopMarkerBytes = Buffer.from(homeGuardStopMarker);

/** A watcher for the stop marker in one stream. */
export function watchForStopMarker(): StreamMarkerWatcher {
  return new StreamMarkerWatcher(stopMarkerBytes);
}
