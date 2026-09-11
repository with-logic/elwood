/**
 * Process-wide async mutex for the macOS clipboard. The clipboard is a single
 * global resource, but Elwood sessions serialize only per-session, so two
 * concurrent Codex image attaches could interleave their snapshot/set/paste/
 * restore transactions and cross-attach each other's images. This serializes the
 * whole transaction across all sessions in the process. Implements PRD §5.3
 * (C-API-46).
 */

import { createAsyncMutex } from "../../core/async-mutex.ts";

/**
 * Runs `task` while holding the clipboard lock: each caller waits for the prior
 * holder to finish before starting, and the lock is released when `task`
 * settles (success or failure), so a failing attach never wedges the queue.
 */
export const withClipboardLock = createAsyncMutex();
