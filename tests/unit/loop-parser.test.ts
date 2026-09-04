/**
 * Unit coverage for the explicit recurring-loop command parser.
 * Covers PRD §5.9 and C-LOOP-02/C-LOOP-03.
 */

import { describe, expect, test } from "vitest";
import { ElwoodError, parseLoopCommand } from "../../src/index.ts";

function invalidCommand(command: string): ElwoodError {
  try {
    parseLoopCommand(command);
  } catch (error) {
    if (error instanceof ElwoodError) return error;
    throw error;
  }
  throw new Error("expected invalid_loop");
}

describe("parseLoopCommand", () => {
  test("C-LOOP-02 parses fixed and idle commands into creation requests", () => {
    expect(parseLoopCommand("/loop 60s check status")).toEqual({
      mode: "fixed",
      intervalMs: 60_000,
      message: "check status",
    });
    expect(parseLoopCommand("/loop 2m say  hello ")).toEqual({
      mode: "fixed",
      intervalMs: 120_000,
      message: "say  hello ",
    });
    expect(parseLoopCommand("/loop remind me when idle ")).toEqual({
      mode: "idle",
      message: "remind me when idle ",
    });
  });

  test("C-LOOP-03 recognizes every unit and only exact loop commands", () => {
    expect(parseLoopCommand("/loop 1m minute")).toMatchObject({ intervalMs: 60_000 });
    expect(parseLoopCommand("/loop 1h hour")).toMatchObject({ intervalMs: 3_600_000 });
    expect(parseLoopCommand("/loop 1d day")).toMatchObject({ intervalMs: 86_400_000 });
    expect(parseLoopCommand("loop 1m nope")).toBeUndefined();
    expect(parseLoopCommand(" /loop 1m nope")).toBeUndefined();
    expect(parseLoopCommand("/loops 1m nope")).toBeUndefined();
    expect(parseLoopCommand("/LOOP 1m nope")).toBeUndefined();
  });

  test("C-LOOP-03 treats non-positive and non-matching first tokens as idle text", () => {
    for (const message of ["0m hello", "-1m hello", "1.5m hello", "1ms hello", "1M hello"]) {
      expect(parseLoopCommand(`/loop ${message}`)).toEqual({ mode: "idle", message });
    }
  });

  test("C-LOOP-03 rejects recognized commands without a message", () => {
    expect(invalidCommand("/loop").code).toBe("invalid_loop");
    expect(invalidCommand("/loop   ").code).toBe("invalid_loop");
    expect(invalidCommand("/loop 1m").code).toBe("invalid_loop");
  });

  test("C-LOOP-03 rejects parsed fixed intervals outside bounds or safe conversion", () => {
    expect(invalidCommand("/loop 59s too soon").code).toBe("invalid_loop");
    expect(invalidCommand("/loop 7d too late").code).toBe("invalid_loop");
    expect(invalidCommand("/loop 9007199254740992s overflow").code).toBe("invalid_loop");
  });

  test("C-LOOP-03 enforces UTF-8 message bytes after parsing", () => {
    expect(parseLoopCommand(`/loop ${"é".repeat(32_768)}`)).toMatchObject({ mode: "idle" });
    expect(invalidCommand(`/loop ${"é".repeat(32_769)}`).code).toBe("invalid_loop");
  });
});
