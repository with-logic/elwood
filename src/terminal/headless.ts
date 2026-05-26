/**
 * Headless xterm.js terminal model for PTY rendering and input control.
 * Implements PRD §4.1, §5.3, and §9.
 */

import xtermHeadless from "@xterm/headless";
import type { TerminalSize } from "../core/types.ts";
import type { PtyProcess } from "../pty/types.ts";

export type XtermTerminal = import("@xterm/headless").Terminal;

export type TerminalSnapshot = {
  readonly cols: number;
  readonly rows: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly lines: readonly string[];
  readonly text: string;
};

export interface ElwoodTerminal {
  readonly xterm: XtermTerminal;
  readonly size: TerminalSize;
  writeOutput(data: string | Uint8Array): Promise<void>;
  sendInput(input: string | Uint8Array): void;
  resize(size: TerminalSize): void;
  snapshot(): TerminalSnapshot;
  dispose(): void;
}

export function createHeadlessTerminal(
  size: TerminalSize,
  onInput: (input: string | Uint8Array) => void,
): ElwoodTerminal {
  return new HeadlessTerminal(size, onInput);
}

export function attachPtyTerminal(
  size: TerminalSize,
  pty: PtyProcess,
  onRendered: (data: string, terminal: ElwoodTerminal) => void,
): ElwoodTerminal {
  const terminal = createHeadlessTerminal(size, (input) => pty.write(input));
  pty.onData((data) => {
    void terminal.writeOutput(data).then(() => onRendered(data, terminal));
  });
  return terminal;
}

class HeadlessTerminal implements ElwoodTerminal {
  readonly xterm: XtermTerminal;
  private currentSize: TerminalSize;
  private readonly onInput: (input: string | Uint8Array) => void;

  constructor(size: TerminalSize, onInput: (input: string | Uint8Array) => void) {
    this.currentSize = size;
    this.onInput = onInput;
    this.xterm = new xtermHeadless.Terminal({
      allowProposedApi: true,
      cols: size.cols,
      rows: size.rows,
    });
    this.xterm.onData(onInput);
  }

  get size(): TerminalSize {
    return this.currentSize;
  }

  writeOutput(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve) => this.xterm.write(data, resolve));
  }

  sendInput(input: string | Uint8Array): void {
    if (typeof input === "string") {
      this.xterm.input(input);
      return;
    }
    this.onInput(input);
  }

  resize(size: TerminalSize): void {
    this.currentSize = size;
    this.xterm.resize(size.cols, size.rows);
  }

  snapshot(): TerminalSnapshot {
    const buffer = this.xterm.buffer.active;
    const lines = Array.from(
      { length: this.currentSize.rows },
      (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
    );
    return {
      cols: this.currentSize.cols,
      rows: this.currentSize.rows,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      lines,
      text: lines.join("\n"),
    };
  }

  dispose(): void {
    this.xterm.dispose();
  }
}
