/**
 * Points `CODEX_HOME` at a test's sandbox and restores the value the process started
 * with, and plays the launch shell's `CODEX_HOME` report for fake PTYs. Shared by the unit
 * and conformance suites' Codex config tests (PRD §4.2, §5.3 and §5.7, C-API-23,
 * C-CODEX-14 and C-CODEX-24).
 */

import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PtySpawnOptions } from "../../src/pty/types.ts";

const originalCodexHome = process.env["CODEX_HOME"];

/**
 * Points `CODEX_HOME` at the existing directory `home` and returns that home's `config.toml`
 * path as a session names it: Codex canonicalizes `CODEX_HOME`, and so does Elwood.
 */
export function useCodexHome(home: string): string {
  process.env["CODEX_HOME"] = home;
  return join(realpathSync(home), "config.toml");
}

/** Restores the `CODEX_HOME` the process started with; pair with `useCodexHome`. */
export function restoreCodexHome(): void {
  if (originalCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalCodexHome;
}

/**
 * Plays a Codex launch script's `CODEX_HOME` report step for a fake PTY, the way a shell whose
 * startup files export nothing new would: from this process's `CODEX_HOME` and `HOME`, in the
 * PTY's directory. Any other launch (Claude, or a test's own command) is left alone.
 */
export function answerCodexHomeReport(options: Pick<PtySpawnOptions, "args" | "cwd">): void {
  const reportPath = codexHomeReportPath(options.args);
  if (reportPath === undefined) return;
  const { env } = process;
  writeFileSync(reportPath, `${env["CODEX_HOME"] ?? ""}\0${env["HOME"] ?? ""}\0${options.cwd}\0`);
}

/** Where a Codex launch script's report step writes; undefined for any other launch. */
export function codexHomeReportPath(args: readonly string[]): string | undefined {
  const step = / > '((?:[^']|'\\'')*)' \|\| exit 73; exec codex /.exec(args.at(-1) ?? "");
  return step?.[1]?.replaceAll("'\\''", "'");
}
