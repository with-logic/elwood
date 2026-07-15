/**
 * Resize persistence helpers shared by every adapter session.
 * Implements PRD §5.3 and C-API-39/C-PTY-05: a direct resize updates both
 * terminal models and persists the size, while a HELD (deferred-physical) resize
 * records only the requested size — leaving the live pty/terminal at their
 * bootstrap geometry — so an exit before the deferred restore resumes at the
 * latest requested size, and a resize racing process exit persists nothing.
 */

import type { TerminalSize } from "../core/types.ts";
import type { PtyProcess } from "../pty/types.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";

type PersistSize = (size: TerminalSize) => void;

/** Apply a resize to both terminal models and persist it; a closed fd is a no-op. */
export function applyResize(
  pty: PtyProcess,
  terminal: ElwoodTerminal,
  persist: PersistSize,
  size: TerminalSize,
): void {
  if (pty.resize(size) === "closed") return;
  terminal.resize(size);
  persist(size);
}

/**
 * Persist a held resize's requested size without disturbing the bootstrap
 * geometry. Liveness is probed by resizing the pty to its CURRENT dimensions — a
 * physical no-op that still reports a closed fd — so a resize racing exit persists
 * nothing that could never apply (C-PTY-05).
 */
export function persistHeldResize(
  pty: PtyProcess,
  terminal: ElwoodTerminal,
  persist: PersistSize,
  size: TerminalSize,
): void {
  if (pty.resize(terminal.size) !== "closed") persist(size);
}

/**
 * Apply a held resize's deferred PHYSICAL geometry (PTY + terminal) at the
 * initial-ready transition WITHOUT re-persisting — the size was already durably
 * recorded by `persistHeldResize`. Separating physical restore from persistence
 * means only a genuine native PTY resize error (not a redundant persist failure)
 * can be treated as "stayed at bootstrap width"; a closed fd stays a silent no-op
 * (C-API-39). Returns whether the physical resize applied.
 */
export function restoreHeldResize(
  pty: PtyProcess,
  terminal: ElwoodTerminal,
  size: TerminalSize,
): boolean {
  if (pty.resize(size) === "closed") return false;
  terminal.resize(size);
  return true;
}
