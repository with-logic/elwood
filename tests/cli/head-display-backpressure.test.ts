/** Bounded headed-display output coverage. Implements PRD §12A.6 and C-CLI-18. */

import { describe, expect, test, vi } from "vitest";
import {
  HeadedDisplay,
  maxPendingHeadBytes,
  maxPendingHeadWrites,
  terminalRestore,
} from "../../src/cli/head/display.ts";
import type { CliHeadTarget } from "../../src/cli/head/types.ts";
import { MemoryWriter } from "./run-fakes.ts";

class SlowWriter extends MemoryWriter {
  private callback: ((error?: Error | null) => void) | undefined;
  private drain: (() => void) | undefined;
  private blocked = true;

  override write(value: string, callback: (error?: Error | null) => void): boolean {
    this.writes += 1;
    this.value += value;
    if (this.blocked) {
      this.blocked = false;
      this.callback = callback;
      return false;
    }
    callback();
    return true;
  }

  override once(_event: "drain", handler: () => void): void {
    this.drain = handler;
  }

  release(): void {
    this.callback?.();
    this.drain?.();
  }
}

function target(output: SlowWriter): CliHeadTarget {
  return {
    output,
    size: () => ({ cols: 132, rows: 41 }),
    isRaw: () => false,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    onInput: () => () => {},
    onResize: () => () => {},
  };
}

async function closeAfterDrain(display: HeadedDisplay, writer: SlowWriter): Promise<void> {
  const closing = display.close();
  await Promise.resolve();
  writer.release();
  await closing;
}

describe("headed CLI display backpressure", () => {
  test("C-CLI-18 bounds slow headed output by pending frame count", async () => {
    const writer = new SlowWriter();
    const failed = vi.fn();
    const display = new HeadedDisplay(target(writer));
    display.start({ interrupt: vi.fn(), resize: vi.fn(), failed });
    const accepted = Array.from({ length: maxPendingHeadWrites }, (_, index) => String(index % 10));

    for (const frame of accepted) display.write(frame);
    display.write("rejected");
    display.write("also rejected");
    await closeAfterDrain(display, writer);

    expect(failed).toHaveBeenCalledOnce();
    expect(String(failed.mock.calls[0]?.[0])).toBe(
      "Error: Headed terminal output backlog exceeded.",
    );
    expect(writer.value).toBe(`${accepted.join("")}${terminalRestore}`);
    expect(writer.writes).toBe(maxPendingHeadWrites + 1);
  });

  test("C-CLI-18 counts UTF-8 bytes when bounding slow headed output", async () => {
    const writer = new SlowWriter();
    const failed = vi.fn();
    const display = new HeadedDisplay(target(writer));
    display.start({ interrupt: vi.fn(), resize: vi.fn(), failed });
    const accepted = "💡".repeat(maxPendingHeadBytes / 4);

    display.write(accepted);
    display.write("rejected");
    await closeAfterDrain(display, writer);

    expect(failed).toHaveBeenCalledOnce();
    expect(writer.value).toBe(`${accepted}${terminalRestore}`);
    expect(Buffer.byteLength(accepted)).toBe(maxPendingHeadBytes);
  });
});
