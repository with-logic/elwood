/**
 * Lifecycle status transition rules (PRD §5, §9.4, C-LIFE-04): terminal statuses are
 * sticky except that teardown may supersede any of them.
 */

import { describe, expect, test } from "vitest";
import { canTransition } from "../../src/runtime/session/status.ts";

describe("canTransition", () => {
  test("C-LIFE-04 lifecycle statuses are monotonic after terminal states", () => {
    expect(canTransition("killed", "stopped")).toBe(false);
    expect(canTransition("torn_down", "running")).toBe(false);
    expect(canTransition("exited", "ready")).toBe(false);
    expect(canTransition("running", "ready")).toBe(true);
  });

  test("a status never transitions to itself, and only teardown supersedes a terminal one", () => {
    expect(canTransition("ready", "ready")).toBe(false);
    expect(canTransition("exited", "torn_down")).toBe(true);
    expect(canTransition("torn_down", "torn_down")).toBe(false);
  });
});
