/** Process-stream headed target coverage. Implements PRD §12A.6 and C-CLI-18. */

import { describe, expect, test, vi } from "vitest";
import { HeadedDisplay } from "../../src/cli/head/display.ts";
import { createProcessHeadTarget } from "../../src/cli/head/process.ts";
import { MemoryWriter } from "./run-fakes.ts";

function streams() {
  const inputListeners = new Set<(data: string | Uint8Array) => void>();
  const inputErrorListeners = new Set<(error: Error) => void>();
  const resizeListeners = new Set<() => void>();
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, enabled: boolean) {
      this.isRaw = enabled;
    }),
    resume: vi.fn(),
    pause: vi.fn(),
    on: vi.fn((event: string, handler: (value: string | Uint8Array | Error) => void) => {
      if (event === "data") inputListeners.add(handler);
      else inputErrorListeners.add(handler);
    }),
    off: vi.fn((event: string, handler: (value: string | Uint8Array | Error) => void) => {
      if (event === "data") inputListeners.delete(handler);
      else inputErrorListeners.delete(handler);
    }),
  };
  const stderr = Object.assign(new MemoryWriter(), {
    isTTY: true,
    columns: 122,
    rows: 35,
    on: (_event: string, handler: () => void) => resizeListeners.add(handler),
    off: (_event: string, handler: () => void) => resizeListeners.delete(handler),
  });
  return { stdin, stderr, inputListeners, inputErrorListeners, resizeListeners };
}

describe("process headed target", () => {
  test("C-CLI-18 adapts terminal stdin/stderr and reads live dimensions", () => {
    const h = streams();
    const target = createProcessHeadTarget(h.stdin, h.stderr);
    expect(target?.size()).toEqual({ cols: 122, rows: 35 });
    expect(target?.isRaw()).toBe(false);
    target?.setRawMode(true);
    target?.resume();
    target?.pause();
    expect(h.stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(h.stdin.resume).toHaveBeenCalledOnce();
    expect(h.stdin.pause).toHaveBeenCalledOnce();
    const input = vi.fn();
    const resize = vi.fn();
    const removeInput = target?.onInput(input);
    const removeResize = target?.onResize(resize);
    for (const handler of h.inputListeners) handler("x");
    h.stderr.columns = 91;
    h.stderr.rows = 27;
    for (const handler of h.resizeListeners) handler();
    expect(input).toHaveBeenCalledWith("x");
    expect(resize).toHaveBeenCalledWith({ cols: 91, rows: 27 });
    removeInput?.();
    removeResize?.();
    expect(h.inputListeners.size).toBe(0);
    expect(h.inputErrorListeners.size).toBe(0);
    expect(h.resizeListeners.size).toBe(0);
  });

  test("C-CLI-18 rejects incomplete terminals and falls back for invalid dimensions", () => {
    const h = streams();
    expect(createProcessHeadTarget({}, h.stderr)).toBeUndefined();
    expect(createProcessHeadTarget(null, h.stderr)).toBeUndefined();
    expect(createProcessHeadTarget(h.stdin, new MemoryWriter())).toBeUndefined();
    expect(createProcessHeadTarget({ ...h.stdin, pause: undefined }, h.stderr)).toBeUndefined();
    h.stderr.columns = 0;
    h.stderr.rows = Number.NaN;
    expect(createProcessHeadTarget(h.stdin, h.stderr)?.size()).toEqual({ cols: 189, rows: 48 });
  });

  test("C-CLI-18 contains terminal-gone errors only while restoring a closed input", () => {
    const h = streams();
    const target = createProcessHeadTarget(h.stdin, h.stderr);
    h.stdin.setRawMode.mockImplementation((_enabled: boolean) => {
      throw Object.assign(new Error("setRawMode EIO"), { code: "EIO" });
    });
    expect(() => target?.setRawMode(false)).not.toThrow();
    expect(() => target?.setRawMode(true)).toThrow("setRawMode EIO");
    h.stdin.setRawMode.mockImplementation(() => {
      throw new Error("unexpected failure");
    });
    expect(() => target?.setRawMode(false)).toThrow("unexpected failure");
  });

  test("C-CLI-18 contains asynchronous terminal-gone input errors", () => {
    const h = streams();
    const target = createProcessHeadTarget(h.stdin, h.stderr);
    target?.setRawMode(true);
    const removeInput = target?.onInput(vi.fn());
    for (const handler of h.inputErrorListeners) {
      handler(Object.assign(new Error("read EIO"), { code: "EIO" }));
    }
    expect(() => target?.setRawMode(false)).not.toThrow();
    for (const handler of h.inputErrorListeners) handler(new Error("unexpected read failure"));
    expect(() => removeInput?.()).toThrow("unexpected read failure");
    expect(h.stdin.isRaw).toBe(false);
    expect(h.inputErrorListeners.size).toBe(0);
  });

  test("C-CLI-18 keeps the error guard through delayed raw-mode restoration", async () => {
    const h = streams();
    h.stdin.setRawMode.mockImplementation(function (this: { isRaw: boolean }, enabled: boolean) {
      this.isRaw = enabled;
      if (!enabled) {
        queueMicrotask(() => {
          for (const handler of h.inputErrorListeners) {
            handler(Object.assign(new Error("delayed read EIO"), { code: "EIO" }));
          }
        });
      }
    });
    const target = createProcessHeadTarget(h.stdin, h.stderr);
    if (target === undefined) throw new Error("expected terminal target");
    const failed = vi.fn();
    const display = new HeadedDisplay(target);
    display.start({ interrupt: vi.fn(), resize: vi.fn(), failed });

    await display.close();

    expect(failed).not.toHaveBeenCalled();
    expect(h.stdin.isRaw).toBe(false);
    expect(h.inputErrorListeners.size).toBe(0);
  });

  test("C-CLI-18 rolls back its error listener when input subscription fails", () => {
    const h = streams();
    const target = createProcessHeadTarget(h.stdin, h.stderr);
    h.stdin.on.mockImplementation(
      (event: string, handler: (value: string | Uint8Array | Error) => void) => {
        if (event === "data") throw new Error("data listener failed");
        h.inputErrorListeners.add(handler as (error: Error) => void);
      },
    );

    expect(() => target?.onInput(vi.fn())).toThrow("data listener failed");
    expect(h.inputErrorListeners.size).toBe(0);
  });
});
