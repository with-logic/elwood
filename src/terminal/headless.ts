/**
 * Headless xterm.js terminal model for PTY rendering and input control.
 * Implements PRD §4.1, §5.3, and §9.
 */

import xtermHeadless from "@xterm/headless";
import type { TerminalSize } from "../core/types.ts";
import type { PtyProcess } from "../pty/types.ts";
import { PtyOutput } from "./pty-output.ts";
import { RenderQueue } from "./render-queue.ts";

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
  /** Latest OSC 0/1/2 window title, or "" before any title is set. */
  readonly title: string;
  writeOutput(data: string | Uint8Array): Promise<void>;
  sendInput(input: string | Uint8Array): Promise<void>;
  resize(size: TerminalSize): void;
  snapshot(): TerminalSnapshot;
  /**
   * Resolves once all output received so far has rendered and been observed,
   * including output received while waiting. Never rejects; see `renderFailed`.
   */
  settled(): Promise<void>;
  /** True once any render has failed: `snapshot()` can no longer be vouched for. */
  readonly renderFailed: boolean;
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
  const terminal = new HeadlessTerminal(size, (input) => pty.write(input));
  const output = new PtyOutput(
    (data) => terminal.writeOutput(data, () => onRendered(data, terminal)),
    pty.flowControl,
  );
  terminal.attachOutput(output);
  const unsubscribe = pty.onData((data) => {
    output.push(data);
  });
  terminal.onDispose(unsubscribe);
  return terminal;
}

class HeadlessTerminal implements ElwoodTerminal {
  readonly xterm: XtermTerminal;
  private currentSize: TerminalSize;
  private readonly renders: RenderQueue;
  private ptyOutput: PtyOutput | undefined;
  private readonly onInput: (input: string | Uint8Array) => void;
  private readonly inputWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private readonly disposers: Array<() => void> = [];
  private disposed = false;
  private currentTitle = "";

  constructor(size: TerminalSize, onInput: (input: string | Uint8Array) => void) {
    this.currentSize = size;
    this.onInput = onInput;
    this.xterm = new xtermHeadless.Terminal({
      allowProposedApi: true,
      cols: size.cols,
      rows: size.rows,
    });
    this.renders = new RenderQueue(
      (data, done) => this.xterm.write(data, done),
      () => this.ptyOutput?.flush(),
    );
    this.xterm.onData((input) => this.forwardInput(input));
    this.xterm.onTitleChange((title) => {
      this.currentTitle = title;
    });
  }

  get size(): TerminalSize {
    return this.currentSize;
  }

  get title(): string {
    return this.currentTitle;
  }

  get renderFailed(): boolean {
    return this.renders.renderFailed;
  }

  writeOutput(data: string | Uint8Array, onRendered?: () => void): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.ptyOutput?.flush(); // keep a direct write ordered after PTY output already received
    return this.renders.enqueue(data, onRendered);
  }

  sendInput(input: string | Uint8Array): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Terminal is disposed."));
    if (typeof input !== "string") return this.forwardBytes(input);
    return new Promise((resolve, reject) => {
      this.inputWaiters.push({ resolve, reject });
      this.xterm.input(input);
    });
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

  settled(): Promise<void> {
    return this.renders.settled();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.ptyOutput?.dispose();
    this.renders.dispose();
    this.xterm.dispose();
  }

  onDispose(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  attachOutput(output: PtyOutput): void {
    this.ptyOutput = output;
  }

  private forwardInput(input: string): void {
    const waiter = this.inputWaiters.shift();
    if (!waiter) {
      try {
        this.onInput(input);
      } catch {
        // Unsolicited xterm protocol replies have no caller promise to reject.
      }
      return;
    }
    try {
      this.onInput(input);
      waiter.resolve();
    } catch (error) {
      waiter.reject(error);
    }
  }

  private forwardBytes(input: Uint8Array): Promise<void> {
    try {
      this.onInput(input);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
