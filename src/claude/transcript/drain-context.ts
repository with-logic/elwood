/**
 * Builds the collaborators a transcript drain needs (PRD §5.4, C-CLAUDE-15).
 * Kept beside the watcher so the fs guard, line emitter, drop sink, and the
 * test-injectable drain clock are assembled in exactly one place.
 */

import type { DrainContext } from "./drain.ts";
import type { DropReporter } from "./drops.ts";
import type { LineEmitter } from "./emit.ts";
import type { TranscriptFsGuard } from "./fs-guard.ts";

export type DrainCollaborators = {
  readonly guard: TranscriptFsGuard;
  readonly lines: LineEmitter;
  readonly drops: DropReporter;
  /** Undefined in production; drain.ts then uses `Date.now`. */
  readonly now: (() => number) | undefined;
};

/**
 * The guard's `read` is bound so the shared fs guard still contains a read
 * failure mid-drain (the drain's `readFs` seam maps to it).
 */
export function buildDrainContext(parts: DrainCollaborators): DrainContext {
  return {
    readFs: parts.guard.read.bind(parts.guard),
    lines: parts.lines,
    drops: parts.drops,
    ...(parts.now === undefined ? {} : { now: parts.now }),
  };
}
