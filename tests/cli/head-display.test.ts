/**
 * Same-terminal headed display coverage for full-screen VT/ANSI fidelity.
 * Implements PRD §12A.6 and C-CLI-18.
 */

import { describe, expect, test, vi } from "vitest";
import { HeadedDisplay, terminalRestore } from "../../src/cli/head/display.ts";
import type { CliHeadTarget } from "../../src/cli/head/types.ts";
import type { TerminalSize } from "../../src/core/types.ts";
import { MemoryWriter } from "./run-fakes.ts";

class FakeHeadTarget implements CliHeadTarget {
  readonly output = new MemoryWriter();
  currentSize: TerminalSize = { cols: 132, rows: 41 };
  raw = false;
  resumes = 0;
  pauses = 0;
  input: ((data: string | Uint8Array) => void) | undefined;
  resize: ((size: TerminalSize) => void) | undefined;
  inputRemoved = false;
  resizeRemoved = false;
  size = () => this.currentSize;
  isRaw = () => this.raw;
  setRawMode = (enabled: boolean) => {
    this.raw = enabled;
  };
  resume = () => {
    this.resumes += 1;
  };
  pause = () => {
    this.pauses += 1;
  };
  onInput = (handler: (data: string | Uint8Array) => void) => {
    this.input = handler;
    return () => {
      this.inputRemoved = true;
      this.input = undefined;
    };
  };
  onResize = (handler: (size: TerminalSize) => void) => {
    this.resize = handler;
    return () => {
      this.resizeRemoved = true;
      this.resize = undefined;
    };
  };
}

describe("headed CLI display", () => {
  test("C-CLI-18 preserves full-screen TUI bytes, resizes, interrupts, and restores", async () => {
    const target = new FakeHeadTarget();
    const interrupt = vi.fn();
    const resized: TerminalSize[] = [];
    const failed = vi.fn();
    const display = new HeadedDisplay(target);
    const tui = "\u001b[?1049h\u001b[2J\u001b[4;9H\u001b[38;5;45m⠹ working\u001b[?25l";

    expect(display.initialSize).toEqual({ cols: 132, rows: 41 });
    display.start({
      interrupt,
      resize: (size) => {
        resized.push(size);
      },
      failed,
    });
    display.write(tui);
    target.currentSize = { cols: 101, rows: 29 };
    target.resize?.(target.currentSize);
    target.input?.(Buffer.from([0x1b, 0x5b, 0x4d, 0x03, 0x03]));
    target.input?.("ignored\u0003");
    await display.close();
    await display.close();

    expect(target.output.value).toBe(`${tui}${terminalRestore}`);
    expect(resized).toEqual([{ cols: 101, rows: 29 }]);
    expect(interrupt).toHaveBeenCalledTimes(3);
    expect(failed).not.toHaveBeenCalled();
    expect(target).toMatchObject({ raw: false, resumes: 1, pauses: 1 });
    expect(target.inputRemoved).toBe(true);
    expect(target.resizeRemoved).toBe(true);
  });

  test("C-CLI-18 restores the prior raw mode and contains display closure", async () => {
    const target = new FakeHeadTarget();
    target.raw = true;
    target.output.failAt = 1;
    const failed = vi.fn();
    const display = new HeadedDisplay(target);
    display.start({ interrupt: vi.fn(), resize: vi.fn(), failed });
    display.write("frame");
    await display.close();

    expect(target.raw).toBe(true);
    expect(failed).toHaveBeenCalledOnce();
  });

  test("C-CLI-18 restores enhanced keyboard input before leaving the alternate screen", async () => {
    const target = new FakeHeadTarget();
    const display = new HeadedDisplay(target);
    display.start({ interrupt: vi.fn(), resize: vi.fn(), failed: vi.fn() });
    display.write("\u001b[>7u");

    await display.close();

    expect(target.output.value.endsWith("\u001b[<u\u001b[?1049l")).toBe(true);
  });

  test("closing an unused display is side-effect free", async () => {
    const target = new FakeHeadTarget();
    const display = new HeadedDisplay(target);
    display.write("ignored");
    await display.close();
    display.write("also ignored");
    expect(target.output.value).toBe("");
    expect(target.resumes).toBe(0);

    const attached = new FakeHeadTarget();
    const started = new HeadedDisplay(attached);
    started.start({ interrupt: vi.fn(), resize: vi.fn(), failed: vi.fn() });
    await started.close();
    expect(attached.output.value).toBe("");
  });

  test("unexpected display, resize, and cleanup failures are reported", async () => {
    const target = new FakeHeadTarget();
    target.output.write = (_value, callback) => {
      callback(new Error("write failed"));
      return true;
    };
    target.pause = () => {
      throw new Error("pause failed");
    };
    const failed = vi.fn();
    const display = new HeadedDisplay(target);
    display.start({
      interrupt: vi.fn(),
      resize: () => Promise.reject(new Error("resize failed")),
      failed,
    });
    display.start({ interrupt: vi.fn(), resize: vi.fn(), failed });
    display.write("frame");
    display.write("second frame");
    target.resize?.({ cols: 80, rows: 24 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await display.close();

    expect(failed).toHaveBeenCalledTimes(3);
    expect(failed.mock.calls.map(([error]) => String(error))).toEqual(
      expect.arrayContaining([
        "Error: write failed",
        "Error: resize failed",
        "Error: pause failed",
      ]),
    );
  });
});
