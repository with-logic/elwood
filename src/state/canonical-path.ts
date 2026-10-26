/** Canonical identity after no-follow validation, including absent state paths (PRD §8.1). */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { errnoCode } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";

export function canonicalStatePath(path: string): string {
  const absolute = resolve(path);
  assertStatePath(absolute);
  return withRealAncestor(absolute, realpathSync);
}

/**
 * The absolute `path` with its deepest existing ancestor replaced by that ancestor's real path,
 * as `realpath` gives it, followed by the names that do not exist yet.
 */
export function withRealAncestor(path: string, realpath: (path: string) => string): string {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpath(current), ...missing.reverse());
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      missing.push(basename(current));
    }
  }
}
