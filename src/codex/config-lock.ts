/**
 * Process-wide async mutex for the Codex `config.toml`. The file is a single
 * process-global resource, but Elwood sessions serialize only per-session, so
 * two concurrent `setModel` switches could interleave their snapshot / picker /
 * compare-and-swap restore transactions on the shared file and leave the wrong
 * model persisted as the user's default. This serializes the whole transaction
 * across all sessions in the process. Mirrors clipboard-lock.ts and implements
 * PRD §5.3 setModel restore and C-CODEX-14.
 *
 * SCOPE: this lock is PROCESS-LOCAL. Two separate Elwood processes sharing one
 * `config.toml` can still interleave their transactions — an accepted current
 * limitation (the compare-and-swap still refuses to clobber an unrelated edit).
 * Closing it needs an inter-process lock on the resolved path and is separate work.
 */

import { createAsyncMutex } from "../core/async-mutex.ts";

/**
 * Runs `task` while holding the config lock: each caller waits for the prior
 * holder to finish before starting, and the lock is released when `task`
 * settles (success or failure), so a failing switch never wedges the queue.
 */
export const withCodexConfigLock = createAsyncMutex();
