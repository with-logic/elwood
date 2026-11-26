/**
 * Tracks one headless terminal's renders: what has been received, queued and drawn, the
 * cursor mode the parsed output set, and the frame cached for the current render.
 * Implements PRD §4.1 and C-TRUST-01.
 */
import type { Terminal } from "@xterm/headless";
import type { TerminalSnapshot } from "./headless.ts";
import { NativeRenderEvidence, trackRenderMutations } from "./render-mutations.ts";

const tracked = new WeakMap<Terminal, RenderCursor>();
export type RenderSource = "any" | "pty";
type CachedFrame = { readonly position: string; readonly frame: TerminalSnapshot };

/** The tracker of `terminal`'s renders, shared by every wrapper of that xterm. */
export function renderCursorOf(terminal: Terminal): RenderCursor | undefined {
  return tracked.get(terminal);
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
