/**
 * Snapshot the filesystem paths an ergonomic session launches under (PRD §5.8). The lazy
 * `ClaudeSession`/`CodexSession` classes construct synchronously but launch later; resolving
 * `cwd` (and any relative `stateDir`) at CONSTRUCTION — not at lazy launch — pins the target
 * project so a `process.chdir()` between construction and first use cannot silently launch and
 * auto-trust a different directory or write state elsewhere. The raw factories resolve before
 * their first `await`; this preserves that boundary for the wrappers.
 */

import { isAbsolute, resolve } from "node:path";

/** The session-path options both adapters share: an optional `cwd` and relative-or-absolute `stateDir`. */
type SessionPathOptions = {
  readonly cwd?: string;
  readonly stateDir?: string;
};

/**
 * Return `options` with `cwd` resolved to an absolute path against the current working directory
 * NOW, and any relative `stateDir` resolved against that same snapshot. An already-absolute
 * `stateDir` is left as-is; an omitted `stateDir` stays omitted.
 */
export function resolveSessionPaths<T extends SessionPathOptions>(
  options: T,
): T & { readonly cwd: string } {
  const cwd = resolve(options.cwd ?? process.cwd());
  const stateDir =
    options.stateDir === undefined || isAbsolute(options.stateDir)
      ? options.stateDir
      : resolve(cwd, options.stateDir);
  return stateDir === undefined ? { ...options, cwd } : { ...options, cwd, stateDir };
}
