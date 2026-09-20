/**
 * Per-launch runtime paths, bridge token, and socket for a session. Implements PRD §8.1
 * and §8.2: none of these values are persisted in the session record. They live in
 * memory only — a stored socket path or bridge token is never trusted from disk. The
 * session directory and socket HOME are derived from `(stateDir, id, adapter)`;
 * settings, bridge script, socket FILE and token are minted anew for every launch.
 * Each PTY keeps its own hook route even while another launch is pending. The socket
 * home is ensured private (0700) here. Only the current owner may remove the whole
 * home; a failed launch removes only its own socket file.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalStatePath } from "./canonical-path.ts";
import { newBridgeToken, safeSessionDir } from "./files.ts";
import type { LaunchOwnership } from "./launch-ownership.ts";
import { ensureSocketHome, sessionSocketHome } from "./socket-home.ts";

/** The in-memory runtime a session binds to for one launch (never persisted). */
export type SessionRuntime = {
  readonly sessionDir: string;
  readonly stateOwnership: LaunchOwnership;
  readonly settingsPath: string;
  readonly bridgeScriptPath: string;
  /** The session's STABLE private socket home; teardown removes it whole (§8.1). */
  readonly socketHome: string;
  /** A fresh, short per-launch socket FILE inside `socketHome` (§8.1). */
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
 * `(stateDir, id, adapter)` plus a fresh launch id. The socket lives in the session's
 * STABLE home (outside stateDir, since macOS caps socket paths near 104 bytes) under a FRESH per-launch
 * filename, so no stale socket is reused AND every launch's socket sits under the one
 * home that TEARDOWN can sweep — even after a parent restart. (`stop` keeps the home for
 * a later resume; the bridge unlinks its own socket file on stop.) The bridge token is
 * minted anew so no stale token round-trips.
 */
export function sessionRuntime(
  input: SessionRuntimeInput,
  ownership: LaunchOwnership,
): SessionRuntime {
  const { stateDir, elwoodSessionId, adapter } = input;
  const dir = canonicalStatePath(safeSessionDir(stateDir, elwoodSessionId));
  const launchId = randomUUID();
  const socketHome = sessionSocketHome({ stateDir, elwoodSessionId, adapter });
  ensureSocketHome(socketHome); // restores 0700 on a reused home; rejects a planted non-dir (§8.1)
  return {
    sessionDir: dir,
    stateOwnership: ownership,
    settingsPath: join(dir, `${adapter}-settings-${launchId}.json`),
    bridgeScriptPath: join(dir, `hook-bridge-${launchId}.mjs`),
    socketHome,
    socketPath: join(socketHome, `${randomUUID().slice(0, 8)}.sock`),
    bridgeToken: newBridgeToken(),
  };
}
