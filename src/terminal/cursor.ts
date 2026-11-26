/** Cursor evidence belongs to one completed render, never queued bytes (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";
import type { ElwoodTerminal, TerminalSnapshot } from "./headless.ts";
import { NativeRenderEvidence, trackRenderMutations } from "./render-mutations.ts";
import { terminalSnapshot } from "./snapshot.ts";

const tracked = new WeakMap<Terminal, RenderCursor>();
type RenderSource = "any" | "pty";
type CachedFrame = { readonly position: string; readonly frame: TerminalSnapshot };

export function settledCursorVisible(terminal: Terminal): boolean {
  return tracked.get(terminal)?.settledVisible === true && !terminal.modes.synchronizedOutputMode;
}

/** The cursor mode in the output parsed so far, settled or not. */
export function parsedCursorVisible(terminal: Terminal): boolean {
  return tracked.get(terminal)?.parsedVisible === true;
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
  return tracked.get(terminal.xterm)?.nativeEvidence.intact === true;
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
  return tracked.get(terminal.xterm)?.nativeEvidence.subscribe(listener) ?? (() => undefined);
}

function renderIsSettled(terminal: ElwoodTerminal): boolean {
  return (
    !terminal.renderFailed &&
    tracked.get(terminal.xterm)?.settled === true &&
    !terminal.xterm.modes.synchronizedOutputMode
  );
}

/** Received PTY output is staged or not drawn yet. Host output does not count (C-API-28). */
export function ptyOutputPending(terminal: ElwoodTerminal): boolean {
  return tracked.get(terminal.xterm)?.ptyPending === true;
}

/** True for unknown tracking or received output; this does not attest banner visibility. */
export function hasUnknownOrNonPristineOutput(terminal: ElwoodTerminal): boolean {
  return tracked.get(terminal.xterm)?.arrival !== 0;
}

/** A recovery Enter requires output received after its own physical attempt (C-API-31). */
export function captureRenderProgress(
  terminal: ElwoodTerminal,
  source: RenderSource = "any",
): () => boolean {
  const progressed = tracked.get(terminal.xterm)?.captureProgress(source);
  return () => progressed?.() === true && renderIsSettled(terminal);
}

/** Private queued-input notification; terminal wrappers share the tracked xterm identity. */
export function subscribeRender(terminal: ElwoodTerminal, listener: () => void): () => void {
  return tracked.get(terminal.xterm)?.subscribe(listener) ?? (() => undefined);
}

/** Current live rows. Guard input with `settledLiveSnapshot` when output may still be pending. */
export function cachedLiveSnapshot(terminal: ElwoodTerminal): TerminalSnapshot {
  const { xterm } = terminal;
  const firstBufferRow = xterm.buffer.active.baseY;
  const read = () =>
    terminalSnapshot(xterm, { cols: xterm.cols, rows: xterm.rows }, firstBufferRow);
  return tracked.get(terminal.xterm)?.snapshot(read) ?? read();
}

export class RenderCursor {
  private readonly listeners = new Set<() => void>();
  readonly nativeEvidence = new NativeRenderEvidence();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private receivedRevision = 0;
  private renderedRevision = -1;
  private queuedPtyRevision = -1; // Writes draw in order: the last PTY batch draws last.
  private arrivals = 0;
  private renderedArrivals = 0;
  private renderedPtyArrival = 0;
  private visible = true;
  private readonly handlers: readonly { dispose(): void }[];
  private readonly terminal: Terminal;
  private readonly hasStagedOutput: () => boolean;
  private cachedFrame: CachedFrame | undefined;

  constructor(terminal: Terminal, hasStagedOutput: () => boolean) {
    this.terminal = terminal;
    this.hasStagedOutput = hasStagedOutput;
    tracked.set(terminal, this);
    const reset = () => {
      this.visible = true;
      return false;
    };
    const invalidate = () => {
      this.cachedFrame = undefined;
    };
    this.handlers = [
      ...(["h", "l"] as const).map((final) =>
        terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
          if (params.includes(25)) this.visible = final === "h";
          return false;
        }),
      ),
      terminal.parser.registerEscHandler({ final: "c" }, reset),
      terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, reset),
      terminal.onResize(() => {
        invalidate();
        // Reflow can add apparent padding to clipped rows. A later PTY batch may
        // repaint only part of the viewport. After output arrives, a size change
        // may require handling the current startup dialog through the terminal.
        // A new session can establish native evidence again.
        if (this.arrivals > 0) this.nativeEvidence.invalidate();
      }),
      {
        dispose: trackRenderMutations(terminal, invalidate, () =>
          this.nativeEvidence.observeMutation(),
        ),
      },
    ];
  }

  received(): number {
    this.arrivals += 1;
    return ++this.receivedRevision;
  }
  /** A staged PTY batch enters the render queue. This advances settlement, not arrivals. */
  queued(): number {
    this.queuedPtyRevision = ++this.receivedRevision;
    return this.queuedPtyRevision;
  }
  get arrival(): number {
    return this.arrivals;
  }
  rendered(revision: number, arrival: number, fromPty: boolean): void {
    this.renderedRevision = revision;
    this.renderedArrivals = arrival;
    if (fromPty) this.renderedPtyArrival = arrival;
    this.cachedFrame = undefined;
    for (const listener of this.listeners) listener();
  }
  captureProgress(source: RenderSource): () => boolean {
    const before = this.arrivals;
    return () => (source === "pty" ? this.renderedPtyArrival : this.renderedArrivals) > before;
  }
  get settled(): boolean {
    return this.receivedRevision === this.renderedRevision && !this.hasStagedOutput();
  }
  get ptyPending(): boolean {
    return this.hasStagedOutput() || this.renderedRevision < this.queuedPtyRevision;
  }
  get parsedVisible(): boolean {
    return this.visible;
  }
  get settledVisible(): boolean {
    return this.visible && this.settled;
  }
  snapshot(capture: () => TerminalSnapshot): TerminalSnapshot {
    const buffer = this.terminal.buffer.active;
    const position = [
      this.terminal.cols,
      this.terminal.rows,
      buffer.cursorX,
      buffer.cursorY,
      buffer.baseY,
    ].join(":");
    const known = this.cachedFrame;
    if (known?.position === position) return known.frame;
    const frame = capture();
    this.cachedFrame = { position, frame };
    return frame;
  }
  dispose(): void {
    this.nativeEvidence.invalidate();
    tracked.delete(this.terminal);
    this.listeners.clear();
    for (const handler of this.handlers) handler.dispose();
  }
}
