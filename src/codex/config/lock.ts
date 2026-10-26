/**
 * Per-file async mutex for Codex `config.toml`. Elwood sessions serialize only
 * per-session, so two concurrent `setModel` switches on one config file could
 * interleave their snapshot / picker / compare-and-swap restore transactions and
 * leave the wrong model persisted as the user's default. The lock is keyed per canonical
 * config file: every path that names one file (a symlinked home or config, another letter
 * case or Unicode form) shares its lock, and sessions whose configs have different keys never
 * wait on each other. Paths that differ only in case share a key on every volume, so on a
 * case-sensitive volume two such files share a lock. Implements PRD §5.3 setModel restore and
 * C-CODEX-14.
 *
 * SCOPE: this lock is PROCESS-LOCAL. Two separate Elwood processes sharing one
 * `config.toml` can still interleave their transactions — an accepted current
 * limitation (the compare-and-swap still refuses to clobber an unrelated edit).
 * Closing it needs an inter-process lock on the resolved path and is separate work.
 */

import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { type AsyncMutex, createAsyncMutex, type MutexCancel } from "../../core/async-mutex.ts";
import { elwoodError, errnoCode } from "../../core/errors.ts";

type FileLock = { readonly run: AsyncMutex; users: number };

/** Locks with a holder or a waiter; an idle file's entry is removed. */
const locks = new Map<string, FileLock>();

/**
 * Runs `task` while holding the lock for the config file at `path`: each caller on that
 * file waits for the prior holder to finish before starting, and the lock is released when
 * `task` settles (success or failure), so a failing switch never wedges the queue. A path
 * that cannot be resolved rejects without running `task`.
 */
export function withCodexConfigLock<T>(
  path: string,
  task: () => Promise<T>,
  cancel?: MutexCancel,
): Promise<T> {
  let key: string;
  try {
    key = configFileIdentity(path);
  } catch (error) {
    return Promise.reject(error);
  }
  const lock = locks.get(key) ?? { run: createAsyncMutex(), users: 0 };
  locks.set(key, lock);
  lock.users += 1;
  const result = lock.run(task, cancel);
  const release = () => {
    lock.users -= 1;
    if (lock.users === 0) locks.delete(key);
  };
  result.then(release, release);
  return result;
}

/** How many lock entries currently have a holder or waiter. */
export function codexConfigLocksForTests(): number {
  return locks.size;
}

/**
 * The key for the file at `path`, so every path naming it shares one lock: its canonical path,
 * spelled by `lockSpelling`. A config Codex has not created yet is named by where it will be: a
 * dangling symlink by its target, otherwise by its deepest existing directory's canonical path
 * plus the names still to be created. Any other failure to resolve it rejects, since a fallback
 * could give two names for one file two locks.
 */
function configFileIdentity(path: string): string {
  const unresolved: string[] = [];
  for (let candidatePath = path; ; candidatePath = dirname(candidatePath)) {
    const real = realpathIfPresent(candidatePath);
    if (real !== undefined) return lockSpelling(join(real, ...unresolved));
    const target = unresolved.length === 0 ? linkTarget(path) : undefined;
    // Relative to the link's own directory, followed physically, as the kernel follows it.
    if (target !== undefined)
      return configFileIdentity(isAbsolute(target) ? target : `${dirname(path)}/${target}`);
    unresolved.unshift(basename(candidatePath));
  }
}

/**
 * One spelling for every way of writing a path: Unicode-decomposed and fully case-folded.
 * macOS volumes ignore Unicode normalization, and the default APFS folds case fully, so `ß`,
 * `ẞ`, `ss`, and `SS` name one file; lower-casing alone keeps `ß`. Lower, upper, then lower
 * case again folds them all to `ss`. Every key is folded the same way, never by asking the
 * volume, so a key cannot change when its file appears. On a case-sensitive volume, two configs
 * whose paths differ only in case share a lock too, which only makes one switch wait for the
 * other.
 */
function lockSpelling(path: string): string {
  return path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFD");
}

/** `path`'s canonical path, or `undefined` when it does not exist. */
function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const errno = errnoCode(error);
    if (errno === "ENOENT") return undefined;
    throw unresolvable(path, errno);
  }
}

/** A missing file's symlink target; `undefined` when nothing is there at all. */
function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch (error) {
    const errno = errnoCode(error);
    if (errno === "ENOENT") return undefined;
    throw unresolvable(path, errno);
  }
}

function unresolvable(path: string, errno: string | undefined) {
  const message = "Could not resolve the Codex config to lock it.";
  return elwoodError("model_automation_failed", message, { path, errno });
}
