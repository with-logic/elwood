/** Ordered raw VT display and terminal restoration for CLI head mode (§12A.6, C-CLI-18). */

import { AsyncOutputSink } from "../stream.ts";
import type { CliHeadTarget, HeadedDisplayHandlers } from "./types.ts";

export const terminalRestore =
  "\u001b[?2026l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1004l\u001b[?1006l" +
  "\u001b[?2004l\u001b[0m\u001b[?25h\u001b[?1049l";
export const maxPendingHeadBytes = 4 * 1024 * 1024;
export const maxPendingHeadWrites = 1024;

export class HeadedDisplay {
  readonly initialSize;
  private readonly target: CliHeadTarget;
  private readonly sink: AsyncOutputSink;
  private priorRaw = false;
  private started = false;
  private wrote = false;
  private outputFailed = false;
  private pendingBytes = 0;
  private pendingWrites = 0;
  private removeInput: (() => void) | undefined;
  private removeResize: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private handlers: HeadedDisplayHandlers | undefined;

  constructor(target: CliHeadTarget) {
    this.target = target;
    this.initialSize = target.size();
    this.sink = new AsyncOutputSink(target.output);
  }

  start(handlers: HeadedDisplayHandlers): void {
    if (this.started) return;
    this.started = true;
    this.handlers = handlers;
    this.priorRaw = this.target.isRaw();
    this.target.setRawMode(true);
    this.removeInput = this.target.onInput((data) => this.handleInput(data));
    this.removeResize = this.target.onResize((size) => this.handleResize(size));
    this.target.resume();
  }

  write(data: string): void {
    if (!this.started || this.closePromise !== undefined || this.outputFailed) return;
    const bytes = Buffer.byteLength(data);
    if (
      this.pendingWrites >= maxPendingHeadWrites ||
      this.pendingBytes + bytes > maxPendingHeadBytes
    ) {
      this.failOutput(new Error("Headed terminal output backlog exceeded."));
      return;
    }
    this.wrote = true;
    this.pendingBytes += bytes;
    this.pendingWrites += 1;
    void this.sink.write(data).then(
      (open) => {
        this.settleWrite(bytes);
        if (!open) this.failOutput(new Error("Headed terminal closed."));
      },
      (error) => {
        this.settleWrite(bytes);
        this.failOutput(error);
      },
    );
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (!this.started) {
      this.sink.dispose();
      return;
    }
    const failures: unknown[] = [];
    contain(() => this.removeResize?.(), failures);
    contain(() => this.target.pause(), failures);
    contain(() => this.target.setRawMode(this.priorRaw), failures);
    await new Promise<void>((resolve) => setImmediate(resolve));
    contain(() => this.removeInput?.(), failures);
    await this.sink.flush();
    if (this.wrote) await this.sink.write(terminalRestore).catch(() => false);
    this.sink.dispose();
    if (failures[0] !== undefined) this.handlers?.failed(failures[0]);
  }

  private handleInput(data: string | Uint8Array): void {
    for (const byte of Buffer.from(data)) {
      if (byte === 0x03) this.handlers?.interrupt();
    }
  }

  private handleResize(size: Parameters<HeadedDisplayHandlers["resize"]>[0]): void {
    void Promise.resolve(this.handlers?.resize(size)).catch((error) =>
      this.handlers?.failed(error),
    );
  }

  private settleWrite(bytes: number): void {
    this.pendingBytes -= bytes;
    this.pendingWrites -= 1;
  }

  private failOutput(error: unknown): void {
    if (this.outputFailed) return;
    this.outputFailed = true;
    this.handlers?.failed(error);
  }
}

function contain(operation: () => unknown, failures: unknown[]): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}
