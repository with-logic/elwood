/**
 * Shared runtime defaults for Elwood sessions.
 * Implements PRD §5.1 and §5.5.
 */

import type { TerminalSize } from "./types.ts";

export const defaultTerminalSize: TerminalSize = { cols: 189, rows: 48 };
