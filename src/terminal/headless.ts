/** Headless PTY rendering and input control (PRD §4.1, §5.3, §9). */
import xtermHeadless from "@xterm/headless";
import type { TerminalSize } from "../core/types.ts";
import type { PtyProcess } from "../pty/types.ts";
import { RenderCursor } from "./cursor.ts";
import { PtyOutput } from "./pty-output.ts";
import { RenderQueue } from "./render-queue.ts";
import { retainFinalScreen } from "./screen.ts";
import { type TerminalSnapshot, terminalSnapshot } from "./snapshot.ts";

export type { TerminalSnapshot } from "./snapshot.ts";
export type XtermTerminal = import("@xterm/headless").Terminal;

export interface ElwoodTerminal {
  readonly xterm: XtermTerminal;
  readonly size: TerminalSize;
  /** Latest OSC 0/1/2 window title, or "" before any title is set. */
  readonly title: string;
  /** Renders host output without advancing native PTY progress. */
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
  return HeadlessTerminal.fromPty(size, pty, onRendered);
}

class HeadlessTerminal implements ElwoodTerminal {
  readonly xterm: XtermTerminal;
  readonly #cursor: RenderCursor;
  private currentSize: TerminalSize;
  private readonly renders: RenderQueue;
  #ptyOutput?: PtyOutput;
  private readonly onInput: (input: string | Uint8Array) => void;
  private readonly inputWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private readonly disposers: Array<() => void> = [];
  private disposed = false;
  private currentTitle = "";

  static fromPty(
    size: TerminalSize,
    pty: PtyProcess,
    onRendered: (data: string, terminal: ElwoodTerminal) => void,
  ): HeadlessTerminal {
    const terminal = new HeadlessTerminal(size, (input) => pty.write(input));
    const output = new PtyOutput(
      (data) => terminal.#enqueueOutput(data, () => onRendered(data, terminal)),
      pty.flowControl,
    );
    terminal.#ptyOutput = output;
    // Resume at child exit so unread tail output is not stranded behind backpressure.
    terminal.disposers.push(
      pty.onData((data) => {
        if (data.length > 0) terminal.#cursor.received();
        output.push(data);
      }),
      pty.onExit(() => output.releaseFlowControl()),
    );
    return terminal;
  }

  constructor(size: TerminalSize, onInput: (input: string | Uint8Array) => void) {
    this.currentSize = size;
    this.onInput = onInput;
    this.xterm = new xtermHeadless.Terminal({
      allowProposedApi: true,
      cols: size.cols,
      rows: size.rows,
    });
    this.#cursor = new RenderCursor(this.xterm, () => this.#ptyOutput?.hasStagedOutput === true);
    this.disposers.push(() => this.#cursor.dispose());
    this.renders = new RenderQueue(
      (data, done) => this.xterm.write(data, done),
      () => this.#ptyOutput?.flush(),
      () => this.#cursor.nativeEvidence.invalidate(),
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

  writeOutput(data: string | Uint8Array): Promise<void> {
    return this.#enqueueOutput(data);
  }

  // Only the PTY callback can tag a render as native. Its bytes were counted on receipt.
  #enqueueOutput(data: string | Uint8Array, onPtyRendered?: () => void): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.#ptyOutput?.flush(); // keep a direct write ordered after PTY output already received
    const fromPty = onPtyRendered !== undefined;
    const revision = fromPty ? this.#cursor.queued() : this.#cursor.received();
    const arrival = this.#cursor.arrival;
    const dispatch = () =>
      this.renders.enqueue(data, () => {
        this.#cursor.rendered(revision, arrival, fromPty);
        onPtyRendered?.();
      });
    return fromPty ? this.#cursor.nativeEvidence.withPtyOutputWrite(dispatch) : dispatch();
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
    return terminalSnapshot(this.xterm, this.currentSize);
  }

  settled(): Promise<void> {
    return this.renders.settled();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Captured before the cursor tracker goes. Output still queued or staged is never drawn.
    const hasUndrawnOutput = this.renders.hasUndrawnWrites || this.#ptyOutput?.hasStagedOutput;
    retainFinalScreen(this, hasUndrawnOutput === true);
    for (const dispose of this.disposers.splice(0)) dispose();
    this.#ptyOutput?.dispose();
    this.renders.dispose();
    this.xterm.dispose();
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
