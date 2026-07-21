/**
 * Shared hook bridge request byte ceiling.
 * Implements PRD §6.3 (fail-open-on-overflow request size cap).
 */

/**
 * Maximum raw byte size of a single hook request envelope on the wire, counted
 * identically by the child bridge script and the parent IPC server. A request
 * that exceeds this cap fails open immediately without authentication, parsing,
 * or dispatch. Hook payloads carry arbitrary tool output, so both readers bound
 * buffering here to keep an unauthenticated sender from forcing unbounded growth.
 */
export const MAX_HOOK_REQUEST_BYTES = 8 * 1024 * 1024;
