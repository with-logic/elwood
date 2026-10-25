/**
 * Points `CODEX_HOME` at a test's sandbox and restores the value the process started
 * with. Shared by the unit and conformance suites' Codex config tests (PRD §5.3 and
 * §5.7, C-API-23 and C-CODEX-14).
 */

import { join } from "node:path";

const originalCodexHome = process.env["CODEX_HOME"];

/** Points `CODEX_HOME` at `home` and returns that home's `config.toml` path. */
export function useCodexHome(home: string): string {
  process.env["CODEX_HOME"] = home;
  return join(home, "config.toml");
}

/** Restores the `CODEX_HOME` the process started with; pair with `useCodexHome`. */
export function restoreCodexHome(): void {
  if (originalCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalCodexHome;
}
