/**
 * Internal directory-keyed probe caching, with identity compared at read boundaries.
 * Supports the probe implementation of PRD §9.2; directory keys are an implementation detail.
 */

import { stat } from "node:fs/promises";
import type { DirectoryIdentity } from "../../core/directory-identity.ts";
import { type ChildEnvironment, environmentCacheKey } from "../environment.ts";
import { createProbeCache, type ProbeCache } from "../probe-cache.ts";
import type { CommandOptions } from "../seams.ts";

/** A launch path and, when captured earlier, the directory it must still name. */
export type ProbeDirectory = {
  readonly cwd: string;
  readonly identity?: DirectoryIdentity | undefined;
  readonly env?: ChildEnvironment;
};

/** Preserve a captured identity when passing a directory to the command runner. */
export function probeCommandOptions(directory: ProbeDirectory): CommandOptions {
  const environment = directory.env === undefined ? {} : { env: directory.env };
  return directory.identity === undefined
    ? { cwd: directory.cwd, ...environment }
    : { cwd: directory.cwd, directoryIdentity: directory.identity, ...environment };
}

/**
 * `cwd` and which directory it names (device and inode), so a directory deleted and made again
 * at the same path is probed again rather than answered from the old one's result. None for a
 * path that can't be checked.
 */
async function directoryKey(
  cwd: string,
): Promise<{ readonly key: string; readonly identity: DirectoryIdentity } | undefined> {
  try {
    const { dev, ino } = await stat(cwd, { bigint: true });
    return { key: `${dev}:${ino}:${cwd}`, identity: { dev, ino } };
  } catch {
    return undefined;
  }
}

/** A probe answer, and whether its before/after directory identities matched. */
export type DirectoryRead<T> = { readonly value: T; readonly sameDirectory: boolean };

const directoryCacheBrand = Symbol("DirectoryProbeCache");

/** Only the factory can supply the cache's required boundary-identity admission rule. */
export type DirectoryProbeCache<T> = ProbeCache<DirectoryRead<T>> & {
  readonly [directoryCacheBrand]: true;
};

/** Keeps matching-boundary results only; a caller may further restrict successful values. */
export function createDirectoryProbeCache<T>(
  maxSettledSuccesses: number,
  succeeded: (value: T) => boolean = () => true,
): DirectoryProbeCache<T> {
  return {
    ...createProbeCache<DirectoryRead<T>>(
      maxSettledSuccesses,
      (read) => read.sameDirectory && succeeded(read.value),
    ),
    [directoryCacheBrand]: true,
  };
}

/**
 * `cwd`'s answer from `cache`, else `read()`'s, keyed by path and filesystem identity.
 * The factory refuses retention when identities observed before and after the read differ.
 * The checks compare two snapshots; a replacement restored before the final snapshot
 * can escape detection.
 */
export async function readInDirectory<T>(
  cache: DirectoryProbeCache<T>,
  cwd: string,
  read: (options: CommandOptions) => Promise<T>,
  expectedIdentity?: DirectoryIdentity,
  env?: ChildEnvironment,
): Promise<T> {
  const observed = await directoryKey(cwd);
  const identity = expectedIdentity ?? observed?.identity;
  // An unidentifiable path with no captured identity cannot be shared or retained.
  const environment = env === undefined ? {} : { env };
  if (identity === undefined) return read(probeCommandOptions({ cwd, ...environment }));
  const directoryIdentityKey = `${identity.dev}:${identity.ino}:${cwd}`;
  const key = `${directoryIdentityKey}:${environmentCacheKey(env)}`;
  const matches = observed?.key === directoryIdentityKey;
  const { value } = await cache.get(
    key,
    async () => {
      const value = await read(probeCommandOptions({ cwd, identity, ...environment }));
      return {
        value,
        sameDirectory: matches && (await directoryKey(cwd))?.key === directoryIdentityKey,
      };
    },
    !matches,
  );
  return value;
}
