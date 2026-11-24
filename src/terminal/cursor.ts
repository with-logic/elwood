/** Cursor evidence belongs to one completed render, never queued bytes (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";
import type { ElwoodTerminal, TerminalSnapshot } from "./headless.ts";
import { terminalSnapshot } from "./snapshot.ts";

const tracked = new WeakMap<Terminal, RenderCursor>();
type ScreenLocation = "viewport" | "live";
type CachedFrame = { readonly position: string; readonly frame: TerminalSnapshot };

export function settledCursorVisible(terminal: Terminal): boolean {
  return tracked.get(terminal)?.settledVisible === true && !terminal.modes.synchronizedOutputMode;
}

/** Both trust reads and clearance require all received output to be rendered successfully. */
export function currentRenderedFrame(
  terminal: ElwoodTerminal,
  location: ScreenLocation = "viewport",
): TerminalSnapshot | undefined {
  const cursor = tracked.get(terminal.xterm);
  if (terminal.renderFailed || !cursor?.settled || terminal.xterm.modes.synchronizedOutputMode)
    return undefined;
  return renderedSnapshot(terminal, location);
}

/** True for unknown tracking or received output; this does not attest banner visibility. */
export function hasUnknownOrNonPristineOutput(terminal: ElwoodTerminal): boolean {
  return tracked.get(terminal.xterm)?.arrival !== 0;
}

/** A recovery Enter requires output received after its own physical attempt (C-API-31). */
export function captureRenderProgress(terminal: ElwoodTerminal): () => boolean {
  const progressed = tracked.get(terminal.xterm)?.captureProgress();
  return () => progressed?.() === true && currentRenderedFrame(terminal) !== undefined;
}

/** Private queued-input notification; terminal wrappers share the tracked xterm identity. */
export function subscribeRender(terminal: ElwoodTerminal, listener: () => void): () => void {
  return tracked.get(terminal.xterm)?.subscribe(listener) ?? (() => undefined);
}

/** Internal readers share captured rows when their selected buffer ranges match. */
export function renderedSnapshot(
  terminal: ElwoodTerminal,
  location: ScreenLocation = "viewport",
): TerminalSnapshot {
  const { baseY, viewportY } = terminal.xterm.buffer.active;
  const hiddenLive = location === "live" && baseY !== viewportY;
  const firstBufferRow = hiddenLive ? baseY : viewportY;
  const read = () =>
    hiddenLive
      ? terminalSnapshot(terminal.xterm, terminal.size, firstBufferRow)
      : terminal.snapshot();
  return (
    tracked
      .get(terminal.xterm)
      ?.snapshot(read, firstBufferRow === baseY ? "live" : "viewport", firstBufferRow) ?? read()
  );
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
  private visible = true;
  private readonly handlers: readonly { dispose(): void }[];

  private readonly terminal: Terminal;
  private readonly hasStagedOutput: () => boolean;
  private frames: Partial<Record<ScreenLocation, CachedFrame>> = {};

  constructor(terminal: Terminal, hasStagedOutput: () => boolean) {
    this.terminal = terminal;
    this.hasStagedOutput = hasStagedOutput;
    tracked.set(terminal, this);
    const reset = () => {
      this.visible = true;
      return false;
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
      {
        dispose: invalidateOnMutation(terminal, () => {
          this.frames = {};
        }),
      },
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
  rendered(revision: number, arrival: number): void {
    this.renderedRevision = revision;
    this.renderedArrivals = arrival;
    this.frames = {};
    for (const listener of this.listeners) listener();
  }
  captureProgress(): () => boolean {
    const before = this.arrivals;
    return () => this.renderedArrivals > before;
  }
  get settled(): boolean {
    return this.receivedRevision === this.renderedRevision && !this.hasStagedOutput();
  }
  get settledVisible(): boolean {
    return this.visible && this.settled;
  }
  snapshot(
    capture: () => TerminalSnapshot,
    location: ScreenLocation,
    firstBufferRow: number,
  ): TerminalSnapshot {
    const buffer = this.terminal.buffer.active;
    const position = [
      this.terminal.cols,
      this.terminal.rows,
      buffer.cursorX,
      buffer.cursorY,
      firstBufferRow,
      buffer.baseY,
    ].join(":");
    const known = this.frames[location];
    if (known?.position === position) return known.frame;
    const frame = capture();
    this.frames[location] = { position, frame };
    return frame;
  }
  dispose(): void {
    tracked.delete(this.terminal);
    this.listeners.clear();
    for (const handler of this.handlers) handler.dispose();
  }
}

/** Raw xterm mutations bypass owned revisions, but must never reuse older viewport text. */
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
