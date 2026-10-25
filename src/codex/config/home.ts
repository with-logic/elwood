/**
 * The `CODEX_HOME` a launched Codex runs with, as reported by the shell that launches it.
 * Codex starts through the user's interactive login shell (§4.2), whose startup files can
 * export a `CODEX_HOME` other than Elwood's own, or derive one from `$PWD`, the terminal, or
 * the session's environment. A second shell cannot reproduce all of that, so the launch shell
 * itself reports, just before it starts Codex, the exported values Codex inherits, and the
 * session reads its config.toml path from that report (§5.3). Implements PRD §4.2 and §5.3.
 */

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { elwoodError, errnoCode } from "../../core/errors.ts";
import { shellQuote } from "../../runtime/shell.ts";

// A child `/bin/sh` of the launch shell sees only EXPORTED variables, exactly what Codex
// inherits: an assignment that a startup file did not export reaches neither.
const reportExported = shellQuote(`printf '%s\\0%s\\0' "$CODEX_HOME" "$HOME"`);
const reported = /^([^\0]*)\0([^\0]*)\0$/;

/**
 * The launch-script step that writes Codex's `CODEX_HOME` and `HOME` to `reportPath`. The
 * launch script starts Codex only if this step succeeds, so a running Codex always has one.
 */
export function reportCodexHomeCommand(reportPath: string): string {
  return `/bin/sh -c ${reportExported} > ${shellQuote(reportPath)}`;
}

/**
 * The config.toml of the `CODEX_HOME` in `reportPath`, by Codex's own rule
 * (`find_codex_home`): a non-empty `CODEX_HOME`, which Codex resolves against its working
 * directory, `cwd`; else `$HOME/.codex`, where an empty `HOME` falls back to the account's
 * home directory, as Codex's `home_dir` lookup does.
 */
export function reportedCodexConfigPath(reportPath: string, cwd: string): string {
  const [, codexHome, shellHomeDir] = readReport(reportPath);
  const codexHomeDir = codexHome
    ? resolve(cwd, codexHome)
    : join(shellHomeDir || userInfo().homedir, ".codex");
  return join(codexHomeDir, "config.toml");
}

function readReport(reportPath: string): RegExpExecArray {
  let text: string;
  try {
    text = readFileSync(reportPath, "utf8");
  } catch (error) {
    throw unreadable(reportPath, { code: errnoCode(error) });
  }
  const match = reported.exec(text);
  if (match) return match;
  throw unreadable(reportPath, { cause: "The report is not two NUL-terminated values." });
}

function unreadable(path: string, details: Readonly<Record<string, unknown>>) {
  return elwoodError(
    "model_automation_failed",
    "Could not read the CODEX_HOME this Codex session runs with.",
    { path, ...details },
  );
}
