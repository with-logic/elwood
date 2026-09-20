/** Canonical identity after no-follow validation, including absent state paths (PRD §8.1). */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { errnoCode } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";

export function canonicalStatePath(path: string): string {
  let current = resolve(path);
  assertStatePath(current);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}
