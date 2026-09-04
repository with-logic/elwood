/**
 * Unit coverage for persisted recurring-loop definition validation.
 * Covers PRD §8.2 and C-LOOP-04/C-LOOP-07/C-LOOP-11/C-LOOP-13/C-LOOP-21.
 */

import { describe, expect, test } from "vitest";
import {
  IDLE_LOOP_INTERVAL_MS,
  LOOP_EXPIRATION_MS,
  MAX_ACTIVE_LOOPS,
  MAX_LOOP_INTERVAL_MS,
  MAX_LOOP_MESSAGE_BYTES,
  MIN_LOOP_INTERVAL_MS,
} from "../../src/core/loops/constants.ts";
import { validateLoopSidecar } from "../../src/state/validate-loops.ts";

const createdAt = 1_800_000_000_000;

describe("loop sidecar validation", () => {
  test("C-LOOP-11 returns fresh canonical fixed and idle definitions", () => {
    const first = fixed({ ignored: "definition" });
    const result = validateLoopSidecar({
      schemaVersion: 1,
      ignored: "top-level",
      loops: [first, idle({ id: "idle", jitterMs: 30_000, ignored: true })],
    });
    expect(result).toEqual([fixed(), idle({ id: "idle", jitterMs: 30_000 })]);
    expect(result?.[0]).not.toBe(first);
  });

  test("C-LOOP-04 rejects malformed containers, duplicate IDs, and excess definitions", () => {
    expect(validateLoopSidecar(null)).toBeNull();
    expect(validateLoopSidecar({ schemaVersion: 2, loops: [] })).toBeNull();
    expect(validateLoopSidecar({ schemaVersion: 1, loops: {} })).toBeNull();
    expect(validateLoopSidecar(sidecar([null]))).toBeNull();
    expect(validateLoopSidecar(sidecar([fixed(), fixed()]))).toBeNull();
    const excess = Array.from({ length: MAX_ACTIVE_LOOPS + 1 }, (_, index) =>
      fixed({ id: `loop-${index}` }),
    );
    expect(validateLoopSidecar(sidecar(excess))).toBeNull();
  });

  test("C-LOOP-04 rejects invalid IDs, modes, messages, and interval shapes", () => {
    expect(isInvalid(fixed({ id: "" }))).toBe(true);
    expect(isInvalid(fixed({ mode: "weekly" }))).toBe(true);
    expect(isInvalid(fixed({ message: "" }))).toBe(true);
    expect(isInvalid(fixed({ message: "x".repeat(MAX_LOOP_MESSAGE_BYTES + 1) }))).toBe(true);
    expect(isInvalid(fixed({ intervalMs: MIN_LOOP_INTERVAL_MS - 1 }))).toBe(true);
    expect(isInvalid(fixed({ intervalMs: MAX_LOOP_INTERVAL_MS }))).toBe(true);
    expect(isInvalid(fixed({ intervalMs: MIN_LOOP_INTERVAL_MS + 0.5 }))).toBe(true);
    expect(isInvalid(idle({ intervalMs: IDLE_LOOP_INTERVAL_MS }))).toBe(true);
  });

  test("C-LOOP-07 rejects unsafe or out-of-range jitter", () => {
    expect(isInvalid(fixed({ jitterMs: -1 }))).toBe(true);
    expect(isInvalid(fixed({ jitterMs: 6_001 }))).toBe(true);
    expect(isInvalid(fixed({ jitterMs: 0.5 }))).toBe(true);
    expect(isInvalid(idle({ jitterMs: 30_001 }))).toBe(true);
    expect(isInvalid(idle({ jitterMs: Number.MAX_SAFE_INTEGER + 1 }))).toBe(true);
  });

  test("C-LOOP-13 rejects unsafe timestamps and inconsistent expiry", () => {
    expect(isInvalid(fixed({ createdAt: -1, expiresAt: LOOP_EXPIRATION_MS - 1 }))).toBe(true);
    expect(isInvalid(fixed({ createdAt: 0.5, expiresAt: LOOP_EXPIRATION_MS + 0.5 }))).toBe(true);
    expect(isInvalid(fixed({ expiresAt: createdAt + LOOP_EXPIRATION_MS - 1 }))).toBe(true);
    expect(
      isInvalid(
        fixed({
          createdAt: Number.MAX_SAFE_INTEGER - LOOP_EXPIRATION_MS + 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toBe(true);
  });
});

function sidecar(loops: readonly unknown[]): unknown {
  return { schemaVersion: 1, loops };
}

function isInvalid(definition: unknown): boolean {
  return validateLoopSidecar(sidecar([definition])) === null;
}

function fixed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixed",
    message: "check the deployment",
    mode: "fixed",
    intervalMs: MIN_LOOP_INTERVAL_MS,
    jitterMs: 6_000,
    createdAt,
    expiresAt: createdAt + LOOP_EXPIRATION_MS,
    ...overrides,
  };
}

function idle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "idle-default",
    message: "check when idle",
    mode: "idle",
    jitterMs: 0,
    createdAt,
    expiresAt: createdAt + LOOP_EXPIRATION_MS,
    ...overrides,
  };
}
