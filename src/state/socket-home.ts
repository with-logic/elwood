/**
 * Bridge socket homes kept OUTSIDE stateDir (macOS caps socket paths near 104 bytes,
 * so they cannot live under a caller-structured stateDir). Implements PRD §8.1.
 *
 * A socket home is STABLE per session — `<tmpdir>/elwood-<fingerprint>` where the
 * fingerprint is a bounded, collision-resistant hash of the session's FULL identity
 * `(stateDir, id, adapter)` — so every start/resume of the same session resolves the
 * SAME home directory even after a parent restart (the record persists nothing about
 * it). Fingerprinting the whole identity, not the id alone, means two sessions that
 * happen to share an explicit `elwoodSessionId` in different state dirs get DISTINCT
 * homes, so one's teardown can never remove the other's live socket. Each launch binds
 * a FRESH socket FILE inside that home (a per-launch nonce), so a stale socket is never
 * reused; TEARDOWN removes ALL of a session's socket files by removing the one stable
 * home, so no anonymous per-launch directory can leak undiscoverably across
 * restart/resume cycles. (`stop` keeps the home for a later resume — the bridge unlinks
 * its own socket file on stop; a failed START removes only its own socket file, so an
 * overlapping failed launch never disturbs a live one.) Because teardown removes the
 * WHOLE home, same-process successor ownership gates shared cleanup (§8.1). Separate
 * processes must not run concurrent live launches of one identity.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { canonicalStatePath } from "./canonical-path.ts";

/** The ONE prefix every Elwood socket home carries (shared by creation + cleanup). */
export const SOCKET_HOME_PREFIX = "elwood-";

/**
 * The directory socket homes are minted under. Production always resolves the live
 * `os.tmpdir()`. Socket-leak tests need homes under a private root so their
 * enumeration is exact, and they used to get that by assigning `process.env.TMPDIR`
 * — but `process.env` is per-PROCESS and Vitest's `forks` pool reuses one child
 * process across test files, so the redirect also moved every CONCURRENT file's
 * `os.tmpdir()` into the private dir, which the leak test then deleted. This seam
 * scopes the override to the module that needs it, leaving `os.tmpdir()` untouched.
 */
let socketHomeRoot: string | undefined;

export function setSocketHomeRootForTests(root: string): void {
  socketHomeRoot = root;
}

export function resetSocketHomeRootForTests(): void {
  socketHomeRoot = undefined;
}

/** The full identity a socket home is stable across — mirrors the session-dir key. */
export type SocketHomeIdentity = {
  readonly stateDir: string;
  readonly elwoodSessionId: string;
  readonly adapter: "claude" | "codex";
};

/**
 * The STABLE socket-home directory for a session: `<tmpdir>/elwood-<fingerprint>`. The
 * fingerprint is a bounded (16 hex chars = 64 bits) SHA-256 slice of the session's full
 * identity `(stateDir, id, adapter)` — short enough to keep the socket path under the
 * 104-byte cap, wide enough to make an accidental cross-session collision negligible.
 * Deterministic, so any launch of the session finds the same home; identity-scoped, so
 * a shared explicit id in a different state dir never aliases onto the same home. The
 * state dir is validated and canonicalized first: relative spellings, `..`, and
 * supported root-owned aliases of one directory share a home and launch owner (§8.1).
 */
export function sessionSocketHome(identity: SocketHomeIdentity): string {
  return canonicalSessionSocketHome({
    ...identity,
    stateDir: canonicalStatePath(identity.stateDir),
  });
}

/** Resolve a home from a state root already validated and canonicalized by the caller. */
export function canonicalSessionSocketHome(identity: SocketHomeIdentity): string {
  const stateDir = identity.stateDir;
  const key = `${stateDir}\0${identity.adapter}\0${identity.elwoodSessionId}`;
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(socketHomeRoot ?? tmpdir(), `${SOCKET_HOME_PREFIX}${fingerprint}`);
}

/** Whether `home` is a directory this naming scheme minted (owned cleanup). */
export function ownsSocketHome(home: string): boolean {
  return basename(home).startsWith(SOCKET_HOME_PREFIX);
}

/**
 * Ensures the stable socket home exists and is private (`0700`, PRD §8.1) for THIS
 * launch. The home is deterministic and reused across a session's launches, so
 * `mkdirSync(..., { mode })` alone is not enough — its mode applies only when the
 * directory is freshly created, leaving a pre-existing home at whatever mode it had.
 * We therefore chmod unconditionally after ensuring it. A pre-existing NON-directory
 * (or symlink) at the predictable path is rejected rather than trusted, since binding
 * a socket under an attacker-planted target would escape the private home.
 */
export function ensureSocketHome(home: string): void {
  const existing = lstatIfPresent(home);
  if (existing && !existing.isDirectory()) {
    throw elwoodError("hook_bridge_failed", "socket home path is not a private directory", {
      home,
    });
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined; // absent: mkdir will create it fresh at 0700
  }
}

/**
 * Removes only THIS launch's own socket file, leaving the shared stable home in place.
 * Used on failed startup: the home is shared by every concurrent launch of the same
 * `(stateDir, adapter, session id)`, so a failing launch must NOT remove the whole home
 * — that would delete a live overlapping launch's bound socket. Leaving an empty home
 * is safe: it is deterministic, so the session's next start/resume/teardown collects
 * it. Only removes files under a home this naming scheme owns.
 */
export function removeOwnSocketFile(socketPath: string): void {
  if (!ownsSocketHome(dirname(socketPath))) return;
  rmSync(socketPath, { force: true });
}

/**
 * Removes a session's ENTIRE stable socket home (every launch's socket file), so a
 * parent restart never leaves earlier launches' sockets undiscoverable. Called only on
 * TEARDOWN — the terminal, single-owner path — never on a failed overlapping launch.
 * Only removes homes this naming scheme owns; any other layout is left untouched.
 */
export function removeSocketHome(home: string): void {
  if (!ownsSocketHome(home)) return;
  rmSync(home, { recursive: true, force: true });
}
