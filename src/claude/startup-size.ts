/**
 * Claude startup terminal-width floor. Claude's TUI needs at least this many
 * columns to render its interactive prompt cleanly, so a session requested
 * narrower bootstraps at this width and restores the requested size at initial
 * readiness (PRD §5.3, C-API-36).
 */

import type { TerminalSize } from "../core/types.ts";

export const CLAUDE_STARTUP_MIN_COLS = 100;

/** The size Claude bootstraps at: the requested size, widened to the floor. */
export function claudeStartupSize(requested: TerminalSize): TerminalSize {
  return { ...requested, cols: Math.max(requested.cols, CLAUDE_STARTUP_MIN_COLS) };
}
