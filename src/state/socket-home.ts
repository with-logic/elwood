/**
 * Bridge socket homes kept OUTSIDE stateDir (macOS caps socket paths near 104 bytes,
 * so they cannot live under a caller-structured stateDir). Implements PRD §8.1.
 *
 * A socket home is STABLE per session — `<tmpdir>/elwood-<fingerprint>` where the
 * fingerprint is a bounded, collision-resistant hash of the session id — so every
 * start/resume of the same session resolves the SAME home directory even after a
 * parent restart (the record persists nothing about it). Each launch binds a FRESH
 * socket FILE inside that home (a per-launch nonce), so a stale socket is never
 * reused, while teardown/stop can still remove ALL of a session's socket files by
 * removing the one stable home — no anonymous per-launch directory can leak
 * undiscoverably across restart/resume cycles.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The ONE prefix every Elwood socket home carries (shared by creation + cleanup). */
export const SOCKET_HOME_PREFIX = "elwood-";

/**
 * The STABLE socket-home directory for a session: `<tmpdir>/elwood-<fingerprint>`. The
 * fingerprint is a bounded (16 hex chars = 64 bits) SHA-256 slice of the session id —
 * short enough to keep the socket path under the 104-byte cap, wide enough to make an
 * accidental cross-session collision negligible. Deterministic, so any launch of the
 * session finds the same home.
 */
export function sessionSocketHome(elwoodSessionId: string): string {
  const fingerprint = createHash("sha256").update(elwoodSessionId).digest("hex").slice(0, 16);
  return join(tmpdir(), `${SOCKET_HOME_PREFIX}${fingerprint}`);
}

/** Whether `socketPath` lives in a home this naming scheme minted (owned cleanup). */
export function ownsSocketHome(socketPath: string): boolean {
  return basename(dirname(socketPath)).startsWith(SOCKET_HOME_PREFIX);
}

/**
 * Removes a session's ENTIRE stable socket home (every launch's socket file), so a
 * parent restart never leaves earlier launches' sockets undiscoverable. Only removes
 * homes this naming scheme owns; any other layout is left untouched.
 */
export function removeSocketHome(socketPath: string): void {
  if (!ownsSocketHome(socketPath)) return;
  rmSync(dirname(socketPath), { recursive: true, force: true });
}
