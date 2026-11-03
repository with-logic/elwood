/** Avoid repeated successful ignore-directory syncs within bounded observations (PRD §8.1). */
import { type Stats, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fsyncDir } from "../files.ts";

const MAX_SYNCED_IGNORES = 32;
const synced = new Map<string, string>();

function observation(info: Stats): string {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.nlink,
    info.uid,
    info.gid,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
    info.birthtimeMs,
  ].join(":");
}

/**
 * Call only after validating the ignore afresh. This remembers durability work,
 * never safety checks. Aliases have separate entries; changes restored between
 * observations cannot be detected, so this is not an atomic filesystem guarantee.
 */
export function syncIgnoreDirectory(path: string, info: Stats): void {
  const key = resolve(path);
  const previous = synced.get(key);
  synced.delete(key);
  const parent = dirname(key);
  const before = observation(statSync(parent));
  const current = `${observation(info)}|${before}`;
  if (previous !== current) {
    fsyncDir(parent);
    // A directory changed during the sync has not earned a reusable observation.
    if (observation(statSync(parent)) !== before) return;
  }
  synced.set(key, current);
  if (synced.size > MAX_SYNCED_IGNORES) {
    for (const oldest of synced.keys()) {
      synced.delete(oldest);
      break;
    }
  }
}
