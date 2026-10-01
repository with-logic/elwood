/** Cursor evidence belongs to one completed render, never queued bytes (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";
import type { ElwoodTerminal, TerminalSnapshot } from "./headless.ts";

const tracked = new WeakMap<Terminal, RenderCursor>();

export function settledCursorVisible(terminal: Terminal): boolean {
  return tracked.get(terminal)?.settledVisible === true && !terminal.modes.synchronizedOutputMode;
}

/** Both trust reads and clearance require all received output to be rendered successfully. */
export function currentRenderedFrame(terminal: ElwoodTerminal): TerminalSnapshot | undefined {
  const cursor = tracked.get(terminal.xterm);
  if (terminal.renderFailed || !cursor?.settled || terminal.xterm.modes.synchronizedOutputMode)
    return undefined;
  return cursor.snapshot(() => terminal.snapshot());
}

/** A recovery Enter requires output received after its own physical attempt (C-API-31). */
export function captureRenderProgress(terminal: ElwoodTerminal): () => boolean {
  const progressed = tracked.get(terminal.xterm)?.captureProgress();
  return () => progressed?.() === true && currentRenderedFrame(terminal) !== undefined;
}

/** Called inside an owned render callback; subsequent trust reads reuse this snapshot. */
export function renderedSnapshot(terminal: ElwoodTerminal): TerminalSnapshot {
  return tracked.get(terminal.xterm)?.snapshot(() => terminal.snapshot()) ?? terminal.snapshot();
}

export class RenderCursor {
  private receivedRevision = 0;
  private renderedRevision = -1;
  private arrivals = 0;
  private renderedArrivals = 0;
  private visible = true;
  private readonly handlers: readonly { dispose(): void }[];

  private readonly terminal: Terminal;
  private readonly hasStagedOutput: () => boolean;
  private frame: TerminalSnapshot | undefined;
  private viewportKey = "";

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
    this.frame = undefined;
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
  snapshot(capture: () => TerminalSnapshot): TerminalSnapshot {
    const buffer = this.terminal.buffer.active;
    const viewportKey = [
      this.terminal.cols,
      this.terminal.rows,
      buffer.cursorX,
      buffer.cursorY,
      buffer.viewportY,
      buffer.baseY,
    ].join(":");
    if (this.frame === undefined || this.viewportKey !== viewportKey) {
      this.frame = capture();
      this.viewportKey = viewportKey;
    }
    return this.frame;
  }
  dispose(): void {
    tracked.delete(this.terminal);
    for (const handler of this.handlers) handler.dispose();
  }
}
