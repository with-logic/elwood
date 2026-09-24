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

/** A native render generation; local resize/scroll/cursor changes cannot advance it. */
export function currentRenderGeneration(terminal: ElwoodTerminal): object | undefined {
  return currentRenderedFrame(terminal) && tracked.get(terminal.xterm)!.generation;
}

/** Called inside an owned render callback; subsequent trust reads reuse this snapshot. */
export function renderedSnapshot(terminal: ElwoodTerminal): TerminalSnapshot {
  return tracked.get(terminal.xterm)?.snapshot(() => terminal.snapshot()) ?? terminal.snapshot();
}

export class RenderCursor {
  generation: object = {};
  private receivedRevision = 0;
  private renderedRevision = -1;
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
    return ++this.receivedRevision;
  }
  rendered(revision: number): void {
    this.renderedRevision = revision;
    this.generation = {};
    this.frame = undefined;
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
