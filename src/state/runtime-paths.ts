/**
 * Per-launch runtime paths, bridge token, and socket for a session. Implements PRD §8.1
 * and §8.2: none of these values are persisted in the session record. They live in
 * memory only — a stored socket path or bridge token is never trusted from disk. The
 * session-dir paths and the socket HOME are DERIVED deterministically from the session
 * identity `(stateDir, id, adapter)`, so every launch of a session resolves the same
 * ones; only the socket FILE inside the home and the bridge token are minted anew each
 * launch. The socket home is ensured private (0700) here; teardown removes the whole
 * home, while a failed launch removes only its own socket file (a concurrent launch may
 * share the home).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { newBridgeToken, safeSessionDir } from "./files.ts";
import { ensureSocketHome, sessionSocketHome } from "./socket-home.ts";

/** The in-memory runtime a session binds to for one launch (never persisted). */
export type SessionRuntime = {
  readonly sessionDir: string;
  readonly settingsPath: string;
  readonly bridgeScriptPath: string;
  /** A fresh, short per-launch socket FILE inside the session's stable home (§8.1). */
  readonly socketPath: string;
  /** A fresh bridge token minted for this launch (§8.2). */
  readonly bridgeToken: string;
};

/** The identifying inputs a launch derives its per-launch runtime paths from. */
export type SessionRuntimeInput = {
  readonly stateDir: string;
  readonly elwoodSessionId: string;
  readonly adapter: "claude" | "codex";
};

/**
 * Builds the per-launch runtime for a session. Session-dir paths are derived from
 * `(stateDir, id, adapter)`. The socket lives in the session's STABLE home (outside
 * stateDir, since macOS caps socket paths near 104 bytes) under a FRESH per-launch
 * filename, so no stale socket is reused AND every launch's socket sits under the one
 * home that TEARDOWN can sweep — even after a parent restart. (`stop` keeps the home for
 * a later resume; the bridge unlinks its own socket file on stop.) The bridge token is
 * minted anew so no stale token round-trips.
 */
export function sessionRuntime(input: SessionRuntimeInput): SessionRuntime {
  const { stateDir, elwoodSessionId, adapter } = input;
  const dir = safeSessionDir(stateDir, elwoodSessionId);
  const socketHome = sessionSocketHome({ stateDir, elwoodSessionId, adapter });
  ensureSocketHome(socketHome); // restores 0700 on a reused home; rejects a planted non-dir (§8.1)
  return {
    sessionDir: dir,
    settingsPath: join(dir, `${adapter}-settings.json`),
    bridgeScriptPath: join(dir, "hook-bridge.mjs"),
    socketPath: join(socketHome, `${randomUUID().slice(0, 8)}.sock`),
    bridgeToken: newBridgeToken(),
  };
}
