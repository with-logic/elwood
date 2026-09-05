/**
 * Serialized, backpressure-aware output writes with graceful downstream closure.
 * Implements PRD §12A.3 and C-CLI-12.
 */

export type CliWritable = {
  write(value: string, callback: (error?: Error | null) => void): boolean;
  once(event: "drain", handler: () => void): unknown;
  on?(event: "error", handler: (error: Error) => void): unknown;
  off?(event: "error", handler: (error: Error) => void): unknown;
};

export class AsyncOutputSink {
  private readonly target: CliWritable;
  private tail: Promise<unknown> = Promise.resolve();
  private downstreamClosed = false;
  private streamFailure: Error | undefined;
  private activeFailure: ((error: Error) => void) | undefined;

  constructor(target: CliWritable) {
    this.target = target;
    target.on?.("error", this.onError);
  }

  get closed(): boolean {
    return this.downstreamClosed;
  }

  write(value: string): Promise<boolean> {
    const pending = this.tail.then(() => this.writeNow(value));
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  dispose(): void {
    this.target.off?.("error", this.onError);
  }

  private writeNow(value: string): Promise<boolean> {
    if (this.downstreamClosed) return Promise.resolve(false);
    if (this.streamFailure !== undefined) return Promise.reject(this.streamFailure);
    return new Promise((resolve, reject) => {
      let callbackDone = false;
      let drainDone = true;
      const settle = () => {
        if (callbackDone && drainDone) {
          this.activeFailure = undefined;
          resolve(true);
        }
      };
      const fail = (error: Error) => {
        this.activeFailure = undefined;
        if (isEpipe(error)) {
          this.downstreamClosed = true;
          resolve(false);
        } else {
          this.streamFailure = error;
          reject(error);
        }
      };
      this.activeFailure = fail;
      let accepted: boolean;
      try {
        accepted = this.target.write(value, (error) => {
          if (error) return fail(error);
          callbackDone = true;
          settle();
        });
      } catch (error) {
        fail(asError(error));
        return;
      }
      if (!accepted) {
        drainDone = false;
        this.target.once("drain", () => {
          drainDone = true;
          settle();
        });
      }
      settle();
    });
  }

  private readonly onError = (error: Error): void => {
    if (isEpipe(error)) this.downstreamClosed = true;
    else this.streamFailure = error;
    this.activeFailure?.(error);
  };
}

function isEpipe(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "EPIPE";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Output write failed.");
}
