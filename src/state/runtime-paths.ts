/**
 * Per-launch runtime paths, bridge token, and socket home for a session.
 * Implements PRD §8.1 and §8.2: none of these values are persisted in the session
 * record. They are recomputed fresh at every start/resume and live in memory only —
 * a stored socket path or bridge token is never trusted from disk. The derived
 * session-dir paths are recomputed from `(stateDir, id, adapter)`, and the socket
 * home + bridge token are minted anew each launch.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newBridgeToken, safeSessionDir } from "./files.ts";
import { sessionSocketHome } from "./socket-home.ts";

/** The in-memory runtime a session binds to for one launch (never persisted). */
export type SessionRuntime = {
  readonly sessionDir: string;
  readonly settingsPath: string;
  readonly bridgeScriptPath: string;
  /** A fresh, short private temp socket home minted for this launch (§8.1). */
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
 * home that teardown/stop can sweep — even after a parent restart. The bridge token is
 * minted anew so no stale token round-trips.
 */
export function sessionRuntime(input: SessionRuntimeInput): SessionRuntime {
  const { stateDir, elwoodSessionId, adapter } = input;
  const dir = safeSessionDir(stateDir, elwoodSessionId);
  const socketHome = sessionSocketHome({ stateDir, elwoodSessionId, adapter });
  mkdirSync(socketHome, { recursive: true, mode: 0o700 });
  return {
    sessionDir: dir,
    settingsPath: join(dir, `${adapter}-settings.json`),
    bridgeScriptPath: join(dir, "hook-bridge.mjs"),
    socketPath: join(socketHome, `${randomUUID().slice(0, 8)}.sock`),
    bridgeToken: newBridgeToken(),
  };
}
