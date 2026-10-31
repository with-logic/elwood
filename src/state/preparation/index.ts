/** State scaffolding for a checked launch, with ownership-aware undo (PRD §8.1, C-STATE-14). */

import { join, resolve } from "node:path";
import { assertStatePath, PRIVATE_STATE_MODE, SHARED_STATE_MODE } from "../directories.ts";
import { safeSessionDir, secureMkdir } from "../files.ts";
import { makeStateRoot, makeStateTree } from "../root.ts";
import { createDefaultIgnore } from "./ignore.ts";

/** How a launch's state directory is set up. */
export type StateDirSetup = {
  /**
   * The caller omitted `stateDir`, so this is Elwood's default `<cwd>/.elwood`: readable by
   * local tooling, and given a `.gitignore` of `*` when it has none (an existing one is kept as
   * it is). An explicit `stateDir`, even one naming that same directory, is not.
   */
  readonly isImplicitDefaultStateDir?: boolean;
  /** The session's working directory, which must exist and is never made (C-STATE-14). */
  readonly cwd: string;
  /** Rechecks the directory captured before preflight, when supplied by a launch. */
  readonly assertCwdUnchanged?: () => void;
  /**
   * The session whose directory is made with the rest, so that another start's undo, which
   * removes only empty directories, leaves this start's tree (C-STATE-14).
   */
  readonly elwoodSessionId?: string;
};

/**
 * Makes the state directory, its `sessions` directory, and the session's own directory when
 * one is named, only while the session's `cwd` exists. A root at or under `cwd` is made only
 * below it; a root elsewhere gets its missing parents. Nothing below the root is ever made with
 * parents.
 */
export function prepareStateDir(stateDir: string, setup: StateDirSetup): void {
  const root = resolve(stateDir);
  assertStatePath(root);
  assertStatePath(join(root, "sessions"));
  const isDefault = setup.isImplicitDefaultStateDir === true;
  const sessions = join(root, "sessions");
  const id = setup.elwoodSessionId;
  const session = id === undefined ? undefined : safeSessionDir(root, id);
  let undoIgnore: (() => void) | undefined;
  makeStateTree(
    setup.cwd,
    session ?? sessions,
    () => {
      makeStateRoot(root, isDefault ? SHARED_STATE_MODE : PRIVATE_STATE_MODE, setup.cwd);
      const gitignorePath = join(root, ".gitignore");
      if (isDefault) undoIgnore = createDefaultIgnore(gitignorePath, sessions, id) ?? undoIgnore;
      secureMkdir(sessions);
      if (session !== undefined) secureMkdir(session);
    },
    setup.assertCwdUnchanged,
    () => undoIgnore?.(),
  );
}
