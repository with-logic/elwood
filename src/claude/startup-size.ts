/**
 * Claude startup terminal-width floor. Claude's TUI needs at least this many
 * columns to render its interactive prompt cleanly, so a session requested
 * narrower bootstraps at this width and restores the requested size at initial
 * readiness (PRD §5.3, C-API-36).
 */

export const CLAUDE_STARTUP_MIN_COLS = 100;
