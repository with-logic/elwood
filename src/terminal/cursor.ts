/** Cursor evidence belongs to one completed render, never queued bytes (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";
import type { ElwoodTerminal, TerminalSnapshot } from "./headless.ts";
import { type RenderSource, renderCursorOf } from "./render-cursor.ts";
import { terminalSnapshot } from "./snapshot.ts";

export function settledCursorVisible(terminal: Terminal): boolean {
  return (
    renderCursorOf(terminal)?.settledVisible === true && !terminal.modes.synchronizedOutputMode
  );
}

/** The cursor mode in the output parsed so far, settled or not. */
export function parsedCursorVisible(terminal: Terminal): boolean {
  return renderCursorOf(terminal)?.parsedVisible === true;
}

/** Both trust reads and clearance require all received output to be rendered successfully. */
export function settledLiveSnapshot(terminal: ElwoodTerminal): TerminalSnapshot | undefined {
  return renderIsSettled(terminal) ? cachedLiveSnapshot(terminal) : undefined;
}

/** A native dialog needs an unmodified live viewport. */
export function settledNativeSnapshot(terminal: ElwoodTerminal): TerminalSnapshot | undefined {
  if (!nativeRenderEvidenceIntact(terminal)) return undefined;
  return settledLiveSnapshot(terminal);
}

/** Proof stays revoked after mutations even if further native bytes arrive. */
export function nativeRenderEvidenceIntact(terminal: ElwoodTerminal): boolean {
  return renderCursorOf(terminal.xterm)?.nativeEvidence.intact === true;
}

/**
 * Delivers at most once, in a microtask after the triggering operation.
 * Callbacks are fire-and-forget. Thrown errors and rejected promises are contained.
 * Unsubscribing cancels pending delivery.
 */
export function onNativeRenderEvidenceInvalidated(
  terminal: ElwoodTerminal,
  listener: () => void | Promise<void>,
): () => void {
  return renderCursorOf(terminal.xterm)?.nativeEvidence.subscribe(listener) ?? (() => undefined);
}

function renderIsSettled(terminal: ElwoodTerminal): boolean {
  return (
    !terminal.renderFailed &&
    renderCursorOf(terminal.xterm)?.settled === true &&
    !terminal.xterm.modes.synchronizedOutputMode
  );
}

/** Received PTY output is staged or not drawn yet. Host output does not count (C-API-28). */
export function ptyOutputPending(terminal: ElwoodTerminal): boolean {
  return renderCursorOf(terminal.xterm)?.ptyPending === true;
}

/** True for unknown tracking or received output; this does not attest banner visibility. */
export function hasUnknownOrNonPristineOutput(terminal: ElwoodTerminal): boolean {
  return renderCursorOf(terminal.xterm)?.arrival !== 0;
}

/** A recovery Enter requires output received after its own physical attempt (C-API-31). */
export function captureRenderProgress(
  terminal: ElwoodTerminal,
  source: RenderSource = "any",
): () => boolean {
  const progressed = renderCursorOf(terminal.xterm)?.captureProgress(source);
  return () => progressed?.() === true && renderIsSettled(terminal);
}

/** Private queued-input notification; terminal wrappers share the tracked xterm identity. */
export function subscribeRender(terminal: ElwoodTerminal, listener: () => void): () => void {
  return renderCursorOf(terminal.xterm)?.subscribe(listener) ?? (() => undefined);
}

/** Current live rows. Guard input with `settledLiveSnapshot` when output may still be pending. */
export function cachedLiveSnapshot(terminal: ElwoodTerminal): TerminalSnapshot {
  const { xterm } = terminal;
  const firstBufferRow = xterm.buffer.active.baseY;
  const read = () =>
    terminalSnapshot(xterm, { cols: xterm.cols, rows: xterm.rows }, firstBufferRow);
  return renderCursorOf(terminal.xterm)?.snapshot(read) ?? read();
}
