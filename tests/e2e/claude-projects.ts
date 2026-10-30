/**
 * The project entries of a Claude global config, for the e2e proofs that a private directory
 * never reaches the user's own config (PRD §12, C-E2E-18, C-E2E-23). Claude records one
 * `projects` key per directory it runs in. Side-effect free, so any proof can load it.
 */

import { isAbsolute, relative, sep } from "node:path";
import { isRecord } from "../../src/core/predicates.ts";

/**
 * The `projects` keys of a parsed global config, none when it has no `projects`. Throws when
 * `projects` is not an object, since its entries could then not be checked; `source` names
 * the config in the error.
 */
export function claudeProjectKeys(
  config: Readonly<Record<string, unknown>>,
  source: string,
): readonly string[] {
  const projects = config["projects"];
  if (projects === undefined) return [];
  if (!isRecord(projects))
    throw new Error(`${source} holds a projects value that is not an object`);
  return Object.keys(projects);
}

/**
 * The keys that name one of `dirs`, or a path inside one, compared by path segment, so a
 * sibling such as `<dir>-archive` never matches. Pass every spelling Claude might record for
 * a directory, such as its `/var` and `/private/var` forms.
 */
export function projectKeysWithin(
  keys: readonly string[],
  dirs: readonly string[],
): readonly string[] {
  return keys.filter((key) =>
    dirs.some((dir) => {
      const offset = relative(dir, key);
      return !(offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset));
    }),
  );
}
