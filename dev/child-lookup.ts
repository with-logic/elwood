/**
 * Bounded child-process lookup for dev web app teardown (PRD §11, C-APP-08).
 * Distinguishes "pgrep found no children" (status 1) from an OPERATIONAL failure
 * (spawn error, timeout, signal termination, or an unexpected exit status). A real
 * failure is surfaced through a content-free diagnostic — never silently treated as
 * "no descendants", which would skip descendant cleanup with no signal.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * A bounded, content-free diagnostic that a child-process lookup FAILED for an
 * operational reason rather than simply finding no children. Surfacing it keeps a
 * silently-skipped descendant cleanup visible (C-APP-08) instead of masquerading as
 * "no children". The default reporter writes a single structured line to stderr; the
 * web app can install its own to route it through the debugger's runtime-error path.
 */
export type ChildLookupDiagnostic = {
  readonly pid: number;
  /** Why the lookup failed, as a bounded token — never a raw system message. */
  readonly reason: "spawn_error" | "timeout" | "signal" | "status";
  /** A bounded detail (errno code, signal name, or status number) for diagnosis. */
  readonly detail: string;
};

type ChildLookupReporter = (diagnostic: ChildLookupDiagnostic) => void;

// A single structured stderr line by default; content-free (a bounded reason token
// plus an errno/signal/status detail), so it never leaks conversation content.
let reportChildLookup: ChildLookupReporter = (diagnostic) => {
  process.stderr.write(
    `shutdown child-lookup failed pid=${diagnostic.pid} reason=${diagnostic.reason} detail=${diagnostic.detail}\n`,
  );
};

/**
 * Install a diagnostic reporter for child-process lookup failures so the web app
 * can route them through its bounded structured runtime-error/debugger path
 * (C-APP-08). Returns an ownership-aware disposer: it restores the PRIOR reporter,
 * but ONLY while this reporter is still the installed one — so a later app that has
 * since taken over is never clobbered, and a closed app stops being the target
 * (avoiding a redirected/dangling global across overlapping app instances).
 */
export function setChildLookupReporter(reporter: ChildLookupReporter): () => void {
  const previous = reportChildLookup;
  reportChildLookup = reporter;
  return () => {
    if (reportChildLookup === reporter) reportChildLookup = previous;
  };
}

/** Runs pgrep for `pid`; injectable so a test can drive the failure path. */
export type PgrepRunner = (
  pid: number,
) => Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stdout">;

const SYSTEM_PGREP = "/usr/bin/pgrep";

/**
 * The system `pgrep` when it exists (so a hijacked PATH cannot substitute it), else
 * PATH `pgrep` for hosts that install it elsewhere. Injectable for tests.
 */
export function pgrepExecutable(exists: (path: string) => boolean = existsSync): string {
  return exists(SYSTEM_PGREP) ? SYSTEM_PGREP : "pgrep";
}

// The timeout stops a wedged executable from hanging shutdown.
const runPgrep: PgrepRunner = (pid) =>
  spawnSync(pgrepExecutable(), ["-P", String(pid)], { encoding: "utf8", timeout: 2_000 });

/** Direct children of `pid` via pgrep; surfaces operational failures as diagnostics. */
export function childPids(pid: number, run: PgrepRunner = runPgrep): readonly number[] {
  const result = run(pid);
  // pgrep exits 0 with matches, 1 with NO matches (the common leaf case), and >1 on
  // a real error. A spawn failure or timeout sets `result.error`; a signal kill sets
  // `result.signal`. Only status 1 means "no children"; every OTHER unsuccessful
  // outcome is an OPERATIONAL failure that must be surfaced — not silently treated
  // as "no descendants", which would skip cleanup with no diagnostic (C-APP-08).
  const failure = classifyChildLookup(result);
  if (failure) reportChildLookup({ pid, ...failure });
  if (result.status !== 0) return [];
  return parsePids(result.stdout);
}

/**
 * Classify a pgrep result into an operational-failure diagnostic, or `undefined`
 * when it is a normal outcome (status 0 = matches, status 1 = no matches). Pure and
 * exported so a test can assert status-1 vs error/timeout/signal/other-status
 * without spawning a real process (C-APP-08).
 */
export function classifyChildLookup(
  result: Pick<SpawnSyncReturns<string>, "error" | "signal" | "status">,
): Omit<ChildLookupDiagnostic, "pid"> | undefined {
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (timedOut) return { reason: "timeout", detail: "ETIMEDOUT" };
  if (result.error)
    return { reason: "spawn_error", detail: (result.error as NodeJS.ErrnoException).code ?? "ERR" };
  if (result.signal) return { reason: "signal", detail: result.signal };
  // status 0 (matches) and status 1 (no matches) are both normal; anything else is
  // an unexpected pgrep failure (e.g. status 2 = usage/syntax error).
  if (result.status !== null && result.status > 1)
    return { reason: "status", detail: String(result.status) };
  return undefined;
}

function parsePids(stdout: string): readonly number[] {
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
