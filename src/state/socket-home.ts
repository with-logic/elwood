/**
 * Short-lived bridge socket homes kept outside stateDir.
 * Implements PRD §8.1 and C-STATE-12.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionRecord } from "./store.ts";

/**
 * Rebinds the record's bridge socket into a fresh short private temp home.
 * macOS caps socket paths near 104 bytes, so the socket cannot live under
 * caller-structured stateDir layouts.
 */
export function withFreshSocketPath(record: SessionRecord): SessionRecord {
  const socketHome = mkdtempSync(join(tmpdir(), "elwood-"));
  return { ...record, paths: { ...record.paths, socketPath: join(socketHome, "h.sock") } };
}

export function removeSocketHome(record: SessionRecord): void {
  const socketHome = dirname(record.paths.socketPath);
  // Only remove homes this naming scheme created; legacy records kept the
  // socket inside sessionDir, which the sessionDir removal covers.
  if (!basename(socketHome).startsWith("elwood-")) return;
  rmSync(socketHome, { recursive: true, force: true });
}
