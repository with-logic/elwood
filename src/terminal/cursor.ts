/** Cursor evidence belongs to one completed render, never queued bytes (C-TRUST-01). */
import type { Terminal } from "@xterm/headless";

const tracked = new WeakMap<Terminal, RenderCursor>();

export function settledCursorVisible(terminal: Terminal): boolean {
  return tracked.get(terminal)?.settledVisible === true && !terminal.modes.synchronizedOutputMode;
}

export class RenderCursor {
  private receivedRevision = 0;
  private renderedRevision = -1;
  private visible = true;
  private readonly handlers: readonly { dispose(): void }[];

  private readonly terminal: Terminal;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
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
  }
  get settledVisible(): boolean {
    return this.visible && this.receivedRevision === this.renderedRevision;
  }
  dispose(): void {
    tracked.delete(this.terminal);
    for (const handler of this.handlers) handler.dispose();
  }
}
