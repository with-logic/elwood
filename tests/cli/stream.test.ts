/**
 * Serialized stdout backpressure and EPIPE tests (PRD §12A.3, C-CLI-12).
 */

import { describe, expect, test } from "vitest";
import { AsyncOutputSink } from "../../src/cli/stream.ts";

class ControlledWriter {
  readonly values: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  drain: (() => void) | undefined;
  accepted = true;
  errorHandler: ((error: Error) => void) | undefined;
  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.values.push(value);
    this.callbacks.push(callback);
    return this.accepted;
  }
  once(_event: "drain", handler: () => void): void {
    this.drain = handler;
  }
  on(_event: "error", handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
  off(_event: "error", handler: (error: Error) => void): void {
    if (this.errorHandler === handler) this.errorHandler = undefined;
  }
}

describe("AsyncOutputSink", () => {
  test("C-CLI-12 serializes writes and waits for callback plus drain", async () => {
    const writer = new ControlledWriter();
    writer.accepted = false;
    const sink = new AsyncOutputSink(writer);
    const first = sink.write("one");
    const second = sink.write("two");
    await Promise.resolve();
    expect(writer.values).toEqual(["one"]);
    writer.callbacks[0]?.();
    await Promise.resolve();
    expect(writer.values).toEqual(["one"]);
    writer.accepted = true;
    writer.drain?.();
    await expect(first).resolves.toBe(true);
    await Promise.resolve();
    expect(writer.values).toEqual(["one", "two"]);
    writer.callbacks[1]?.();
    await expect(second).resolves.toBe(true);
    await expect(sink.flush()).resolves.toBeUndefined();
    sink.dispose();
    expect(writer.errorHandler).toBeUndefined();
  });

  test("C-CLI-12 EPIPE latches graceful closure and other errors reject", async () => {
    const closed = new ControlledWriter();
    const closedSink = new AsyncOutputSink(closed);
    const first = closedSink.write("one");
    await Promise.resolve();
    closed.callbacks[0]?.(Object.assign(new Error("pipe"), { code: "EPIPE" }));
    await expect(first).resolves.toBe(false);
    expect(closedSink.closed).toBe(true);
    await expect(closedSink.write("ignored")).resolves.toBe(false);

    const failed = new ControlledWriter();
    const failedSink = new AsyncOutputSink(failed);
    const bad = failedSink.write("bad");
    await Promise.resolve();
    failed.callbacks[0]?.(new Error("disk"));
    await expect(bad).rejects.toThrow(/disk/iu);
    await expect(failedSink.flush()).resolves.toBeUndefined();
  });

  test("C-CLI-12 synchronous and emitted failures settle without uncaught output", async () => {
    const emittedPipe = new ControlledWriter();
    const pipeSink = new AsyncOutputSink(emittedPipe);
    emittedPipe.errorHandler?.(Object.assign(new Error("pipe"), { code: "EPIPE" }));
    await expect(pipeSink.write("ignored")).resolves.toBe(false);

    const thrown = new ControlledWriter();
    thrown.write = () => {
      throw Object.assign(new Error("pipe"), { code: "EPIPE" });
    };
    await expect(new AsyncOutputSink(thrown).write("x")).resolves.toBe(false);

    const emitted = new ControlledWriter();
    emitted.accepted = false;
    const sink = new AsyncOutputSink(emitted);
    const pending = sink.write("x");
    await Promise.resolve();
    emitted.errorHandler?.(new Error("device"));
    await expect(pending).rejects.toThrow(/device/iu);
    await expect(sink.write("later")).rejects.toThrow(/device/iu);

    const primitive = new ControlledWriter();
    primitive.write = () => {
      // biome-ignore lint/style/useThrowOnlyError: exercises hostile non-Error stream implementations.
      throw "failure";
    };
    await expect(new AsyncOutputSink(primitive).write("x")).rejects.toThrow(/output write/iu);
  });
});
