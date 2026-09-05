/**
 * Unit coverage for bounded Codex update-prompt ownership in the headless CLI.
 */

import { describe, expect, test } from "vitest";
import {
  CodexUpdateAttentionGuard,
  codexUpdateAttentionGraceMs,
} from "../../src/cli/update-attention.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";

class GuardClock {
  readonly delays: number[] = [];
  handler: (() => void) | undefined;
  lastHandler: (() => void) | undefined;
  clears = 0;

  setTimer = (handler: () => void, delayMs: number): unknown => {
    this.handler = handler;
    this.lastHandler = handler;
    this.delays.push(delayMs);
    return handler;
  };

  clearTimer = (): void => {
    this.clears += 1;
    this.handler = undefined;
  };
}

describe("CodexUpdateAttentionGuard", () => {
  test("ignores stale ready replays, arms once while blocked, and expires into a block", () => {
    const session: { status: ElwoodSessionStatus } = { status: "ready" };
    const blocks: string[] = [];
    const clock = new GuardClock();
    const guard = new CodexUpdateAttentionGuard(
      session,
      { block: (label) => blocks.push(label) },
      clock,
    );

    guard.attention();
    expect(clock.delays).toEqual([]);
    session.status = "blocked";
    guard.attention();
    guard.attention();
    guard.status("blocked");
    expect(clock.delays).toEqual([codexUpdateAttentionGraceMs]);
    clock.handler?.();
    expect(blocks).toEqual(["codex-update-prompt"]);
  });

  test("success and non-blocked status cancel an armed grace period", () => {
    const session: { status: ElwoodSessionStatus } = { status: "blocked" };
    const clock = new GuardClock();
    const guard = new CodexUpdateAttentionGuard(session, { block: () => {} }, clock);

    guard.attention();
    guard.succeeded();
    guard.attention();
    session.status = "ready";
    guard.status("ready");
    clock.lastHandler?.();
    expect(clock.clears).toBe(2);
  });

  test("a rejected safe write blocks immediately and disposed guards stay inert", () => {
    const session: { status: ElwoodSessionStatus } = { status: "blocked" };
    const blocks: string[] = [];
    const clock = new GuardClock();
    const guard = new CodexUpdateAttentionGuard(
      session,
      { block: (label) => blocks.push(label) },
      clock,
    );

    guard.attention();
    guard.writeFailed();
    guard.succeeded();
    guard.attention();
    const lateTimer = clock.lastHandler;
    guard.dispose();
    guard.attention();
    guard.writeFailed();
    lateTimer?.();
    expect(blocks).toEqual(["codex-update-prompt"]);
    expect(clock.clears).toBe(2);
  });

  test("the default clock can be armed and synchronously disposed", () => {
    const guard = new CodexUpdateAttentionGuard({ status: "blocked" }, { block: () => {} });
    guard.attention();
    guard.dispose();
  });
});
