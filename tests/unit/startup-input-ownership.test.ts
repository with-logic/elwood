/** Startup trust automation must preserve caller-edit and draft ownership (C-API-55/56). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import { PickerInputOwnership } from "../../src/runtime/session/picker-input.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { claudeTrust, codexTrust, tty } from "../fixtures/trust-composer.ts";

afterEach(() => {
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-API-55/56 %s trust automation retains input ownership", async (agent) => {
  const fake = agent === "claude" ? claude : codex;
  fake.installFakes();
  const signals: AbortSignal[] = [];
  const original = PickerInputOwnership.prototype.signal;
  vi.spyOn(PickerInputOwnership.prototype, "signal").mockImplementation(function (
    this: PickerInputOwnership,
  ) {
    const signal = original.call(this);
    if (!signals.includes(signal)) {
      signals.push(signal);
    }
    return signal;
  });
  const session = await (agent === "claude" ? startClaude : startCodex)({
    cwd: fake.tempDir(),
    autotrust: true,
  });
  try {
    const frame =
      agent === "claude"
        ? `${tty(claudeTrust)}\r\n❯ Yes, I trust this folder`
        : `${tty(codexTrust)}\r\n› 1. Yes, continue`;
    fake.ptys[0]!.emitData(frame);
    await expect.poll(() => fake.ptys[0]!.writes.length).toBeGreaterThan(0);
    expect(signals[0]!.aborted).toBe(false);
  } finally {
    await session.teardown();
  }
});
