/** Cursor evidence belongs to one completed render, never queued bytes (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";
import type { ElwoodTerminal, TerminalSnapshot } from "./headless.ts";
import { terminalSnapshot } from "./snapshot.ts";

const tracked = new WeakMap<Terminal, RenderCursor>();
type RenderSource = "any" | "pty";
type CachedFrame = { readonly position: string; readonly frame: TerminalSnapshot };

export function settledCursorVisible(terminal: Terminal): boolean {
  return tracked.get(terminal)?.settledVisible === true && !terminal.modes.synchronizedOutputMode;
}

/** Both trust reads and clearance require all received output to be rendered successfully. */
export function settledLiveSnapshot(terminal: ElwoodTerminal): TerminalSnapshot | undefined {
  return renderIsSettled(terminal) ? cachedLiveSnapshot(terminal) : undefined;
}

function renderIsSettled(terminal: ElwoodTerminal): boolean {
  return (
    !terminal.renderFailed &&
    tracked.get(terminal.xterm)?.settled === true &&
    !terminal.xterm.modes.synchronizedOutputMode
  );
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
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private receivedRevision = 0;
  private renderedRevision = -1;
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
      terminal.onResize(invalidate),
      { dispose: invalidateOnMutation(terminal, invalidate) },
    ];
  }

  received(): number {
    this.arrivals += 1;
    return this.queued();
  }
  /** Split/coalesced rendering advances settlement, not native arrival progress. */
  queued(): number {
    return ++this.receivedRevision;
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
    tracked.delete(this.terminal);
    this.listeners.clear();
    for (const handler of this.handlers) handler.dispose();
  }
}

/** Raw xterm mutations bypass owned revisions and must invalidate cached rows. */
function invalidateOnMutation(terminal: Terminal, invalidate: () => void): () => void {
  const restore: Array<() => void> = [];
  const writes: readonly ("write" | "writeln")[] = ["write", "writeln"];
  for (const method of writes) {
    const original = terminal[method];
    const write = original.bind(terminal);
    terminal[method] = (data, callback) => {
      // writeln can parse its first internal write synchronously after user input.
      invalidate();
      write(data, () => {
        invalidate();
        callback?.();
      });
    };
    restore.push(() => {
      terminal[method] = original;
    });
  }
  const reset = terminal.reset;
  terminal.reset = () => {
    reset.call(terminal);
    invalidate();
  };
  return () => {
    for (const method of restore) method();
    terminal.reset = reset;
  };
}
