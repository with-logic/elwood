/**
 * Focused coverage for web dev app hard shutdown.
 * Covers PRD §11.
 */

import { describe, expect, test } from "bun:test";
import { forceKill, installHardShutdown, isCtrlC } from "../../src/app/web-shutdown.ts";

describe("web dev app hard shutdown", () => {
  test("C-APP-08 registers SIGINT and SIGTERM hard exits", () => {
    const process = new FakeProcess();
    const input = new FakeInput();
    installHardShutdown(process, input);
    expect(input.events).toEqual(["data"]);
    expect([...process.handlers.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    expect(input.rawModes).toEqual([true]);
    expect(input.resumed).toBe(true);
    expect(() => process.handlers.get("SIGINT")?.()).toThrow("exit 130");
    expect(input.rawModes).toEqual([true, false]);
    expect(process.kills).toEqual([{ pid: 1234, signal: "SIGKILL" }]);
    const termProcess = new FakeProcess();
    installHardShutdown(termProcess, new FakeInput(false));
    expect(() => termProcess.handlers.get("SIGTERM")?.()).toThrow("exit 143");
  });

  test("C-APP-08 hard exits when Ctrl-C arrives as stdin bytes", () => {
    const process = new FakeProcess();
    const input = new FakeInput();
    installHardShutdown(process, input);
    expect(() => input.handler?.(new Uint8Array([3]))).toThrow("exit 130");
    expect(input.rawModes).toEqual([true, false]);
    expect(() => input.handler?.("x\u0003")).toThrow("exit 130");
  });

  test("C-APP-08 falls back to exit after SIGKILL attempts", () => {
    const process = new FakeProcess();
    expect(() => forceKill(process, 143)).toThrow("exit 143");
    expect(process.kills).toEqual([{ pid: 1234, signal: "SIGKILL" }]);
    expect(isCtrlC("abc")).toBe(false);
    expect(isCtrlC(new Uint8Array([1, 2]))).toBe(false);
  });
});

class FakeProcess {
  readonly pid = 1234;
  readonly handlers = new Map<string, () => void>();
  readonly kills: { readonly pid: number; readonly signal: string }[] = [];

  once(signal: "SIGINT" | "SIGTERM", handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  kill(pid: number, signal: "SIGKILL"): void {
    this.kills.push({ pid, signal });
  }

  exit(code: number): never {
    throw new Error(`exit ${code}`);
  }
}

class FakeInput {
  readonly isTTY: boolean;
  readonly rawModes: boolean[] = [];
  readonly events: string[] = [];
  resumed = false;
  handler?: (chunk: string | Uint8Array) => void;

  constructor(isTTY = true) {
    this.isTTY = isTTY;
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  on(event: "data", handler: (chunk: string | Uint8Array) => void): void {
    this.events.push(event);
    this.handler = handler;
  }

  resume(): void {
    this.resumed = true;
  }
}
