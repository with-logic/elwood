/**
 * The `CODEX_HOME` a launched Codex runs with, as reported by the shell that launches it.
 * Codex starts through the user's interactive login shell (§4.2), whose startup files can
 * export a `CODEX_HOME` other than Elwood's own, or derive one from `$PWD`, the terminal, or
 * the session's environment. A second shell cannot reproduce all of that, so the launch shell
 * itself reports, just before it starts Codex, the exported values Codex inherits and the
 * directory it starts Codex in, and the session reads its config.toml path from that report
 * (§5.3). Implements PRD §4.2 and §5.3.
 */

import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { elwoodError, errnoCode } from "../../core/errors.ts";
import { abortableDelay } from "../../core/trust/abortable.ts";
import { shellQuote } from "../../runtime/shell.ts";

// A child `/bin/sh` of the launch shell sees only EXPORTED variables, exactly what Codex
// inherits: an assignment that a startup file did not export reaches neither. It also starts
// in the launch shell's directory, where Codex starts, and `$PWD` names that directory.
const reportExported = shellQuote(`printf '%s\\0%s\\0%s\\0' "$CODEX_HOME" "$HOME" "$PWD"`);
const expectedReportValueCount = 3;
// Polled often enough that an operation waiting on a launch shell barely adds to its own
// latency, while each poll stays one small read. The caller's signal bounds the wait.
const reportPollMs = 25;

/** The launch shell's exit status when it could not write the report (sysexits' EX_CANTCREAT). */
export const reportFailedStatus = 73;

/**
 * The launch-script step that writes Codex's `CODEX_HOME`, `HOME`, and directory to
 * `reportPath`, and ends the launch shell with `reportFailedStatus` if it cannot, so Codex
 * starts only after a complete report. The values go to a file, not stdout, because startup
 * files print to the same terminal (banners, tool notices, background jobs) and nothing would
 * separate that from the report.
 */
export function reportCodexHomeCommand(reportPath: string): string {
  return `/bin/sh -c ${reportExported} > ${shellQuote(reportPath)} || exit ${reportFailedStatus}`;
}

/**
 * The config.toml of the `CODEX_HOME` in `reportPath`, by Codex's own rule
 * (`find_codex_home`): a non-empty `CODEX_HOME`, canonicalized the way Codex does, a relative
 * one from the directory Codex runs in; else `$HOME/.codex`, where an empty `HOME` falls back
 * to the account's home directory, as Codex's `home_dir` lookup does. A model operation can
 * start before the launch shell has reached the report, so an unfinished report is waited for
 * until `signal` aborts, which then rejects with its reason.
 */
export async function reportedCodexConfigPath(
  reportPath: string,
  signal: AbortSignal,
): Promise<string> {
  for (;;) {
    const values = readReport(reportPath);
    if (values !== undefined) return join(codexHomeDir(reportPath, values), "config.toml");
    if (!(await abortableDelay(signal, reportPollMs))) throw signal.reason;
  }
}

type ReportedValues = readonly [
  codexHome: string,
  shellHomeDir: string,
  codexWorkingDirectory: string,
];

/** The report's values once complete; `undefined` while the launch shell is still writing it. */
function readReport(reportPath: string): ReportedValues | undefined {
  let text: string;
  try {
    text = readFileSync(reportPath, "utf8");
  } catch (error) {
    const errno = errnoCode(error);
    if (errno === "ENOENT") return undefined;
    throw unreadable(reportPath, { errno });
  }
  const parts = text.split("\0");
  if (isComplete(parts)) {
    const [codexHome, shellHomeDir, codexWorkingDirectory] = parts;
    return [codexHome, shellHomeDir, codexWorkingDirectory];
  }
  // Fewer parts is a report still being written. A value cannot hold a NUL, so anything else
  // is not a report.
  if (parts.length <= expectedReportValueCount) return undefined;
  throw unreadable(reportPath, { cause: "The report is not three NUL-terminated values." });
}

/** Three NUL-terminated values split into four parts, the last one empty. */
function isComplete(parts: readonly string[]): parts is readonly [string, string, string, ""] {
  return parts.length === expectedReportValueCount + 1 && parts[expectedReportValueCount] === "";
}

function codexHomeDir(reportPath: string, values: ReportedValues): string {
  const [codexHome, shellHomeDir, codexWorkingDirectory] = values;
  if (!codexHome) return join(shellHomeDir || userInfo().homedir, ".codex");
  // Joined as text, not with `resolve`, which would drop `dir/..` by name: the kernel, and so
  // Codex's canonicalization, follows `dir` first when it is a symlink, and so does realpath.
  const path = isAbsolute(codexHome) ? codexHome : `${codexWorkingDirectory}/${codexHome}`;
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw unreadable(reportPath, { codexHome: path, errno: errnoCode(error) });
  }
}

function unreadable(path: string, details: Readonly<Record<string, unknown>>) {
  return elwoodError(
    "model_automation_failed",
    "Could not read the CODEX_HOME this Codex session runs with.",
    { path, ...details },
  );
}
