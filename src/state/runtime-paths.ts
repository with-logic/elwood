/**
 * Per-launch runtime paths, bridge token, and socket home for a session.
 * Implements PRD §8.1 and §8.2: none of these values are persisted in the session
 * record. They are recomputed fresh at every start/resume and live in memory only —
 * a stored socket path or bridge token is never trusted from disk. The derived
 * session-dir paths are recomputed from `(stateDir, id, adapter)`, and the socket
 * home + bridge token are minted anew each launch.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newBridgeToken, safeSessionDir } from "./files.ts";

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

/**
 * Builds the per-launch runtime for a session. The session-dir paths are derived
 * from `(stateDir, id, adapter)`; the socket lives in a fresh mkdtemp home because
 * macOS caps socket paths near 104 bytes (so it cannot live under a caller-structured
 * stateDir), and the bridge token is minted anew so no stale token round-trips.
 */
export function sessionRuntime(
  stateDir: string,
  id: string,
  adapter: "claude" | "codex",
): SessionRuntime {
  const dir = safeSessionDir(stateDir, id);
  const socketHome = mkdtempSync(join(tmpdir(), "elwood-"));
  return {
    sessionDir: dir,
    settingsPath: join(dir, `${adapter}-settings.json`),
    bridgeScriptPath: join(dir, "hook-bridge.mjs"),
    socketPath: join(socketHome, "h.sock"),
    bridgeToken: newBridgeToken(),
  };
}
