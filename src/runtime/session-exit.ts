/**
 * Adapter-neutral PTY-exit orchestration (PRD §5.3, C-LIFE-10). Both the Claude
 * and Codex exit boundaries drain the transcript, emit `terminal:exit` + activity,
 * and submit terminal status (which reaps the descendant tree in its own `finally`)
 * in the same order behind the same error boundary. This is that one shared shape.
 */

/**
 * Run the exit-boundary `flushAndEmit` (transcript drain + `terminal:exit`/activity
 * emission) behind an error boundary, then ALWAYS run `submitExit` in a `finally`.
 * `submitExit` submits terminal status and reaps in its OWN `finally`, so a throwing
 * transcript flush, `terminal:exit` listener, or activity listener can never skip
 * the terminal status or the unconditional reap, and no listener failure escapes
 * the native PTY-exit callback (which would leave the reap unrun).
 */
export function finishSessionExit(flushAndEmit: () => void, submitExit: () => void): void {
  try {
    flushAndEmit();
  } catch {
    // A throwing flush/emit listener must not skip terminal status + reap.
  } finally {
    try {
      submitExit();
    } catch {
      // Status was submitted and the reap ran inside submitExit's own finally;
      // contain any late status-listener throw so it can't abort the callback.
    }
  }
}
