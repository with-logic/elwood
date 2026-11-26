/**
 * A failure inside Codex update discovery, outside any frame's own processing, is reported
 * as the session's one `frame_observer_failed` warning and ends discovery, and never escapes
 * as an unhandled rejection or exception (PRD §5.4, §5.13; C-API-72, C-ATTN-12).
 */

import { afterEach, expect, test, vi } from "vitest";
import { firstKeyDelayMs } from "../../src/codex/update-prompt.ts";
import type { ElwoodWarningEvent } from "../../src/index.ts";
import { resetFakes } from "./helpers.ts";
import { closing, listed, openOnFakeTimers, summary } from "./update-dialog-fixture.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

/**
 * Discovery keys an offer by its JSON, so failing that one call fails discovery where it
 * reads a frame, without touching the terminal or the skip that other paths share.
 */
function failOfferKeys() {
  const failing = { now: false };
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof stringify>) => {
    const [value] = args;
    if (failing.now && typeof value === "object" && value !== null && "labels" in value)
      throw new Error("the offer cannot be keyed");
    return stringify(...args);
  });
  return failing;
}

/** Process-level failures that an embedder's process would see. */
function escapedFailures() {
  const failures: unknown[] = [];
  const record = (failure: unknown) => {
    failures.push(failure);
  };
  process.on("unhandledRejection", record);
  process.on("uncaughtException", record);
  return {
    failures,
    /** Lets Node report what escaped, then stops recording. */
    async settle() {
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.off("unhandledRejection", record);
      process.off("uncaughtException", record);
      return failures;
    },
  };
}

const warningCodes = (warnings: readonly ElwoodWarningEvent[]) =>
  warnings.map((warning) => warning.code);

test("C-API-72 C-ATTN-12 a discovery failure once Elwood's skip settles warns once and ends discovery", async () => {
  const failing = failOfferKeys();
  const escaped = escapedFailures();
  const { session, events, paintOffer } = await openOnFakeTimers();
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => {
    warnings.push(warning);
  });
  await closing(session, async () => {
    failing.now = true;
    await paintOffer();
    // Codex never takes the skip's key, so the skip settles when its retries run out and
    // hands the still-drawn offer to discovery.
    await vi.advanceTimersByTimeAsync(firstKeyDelayMs + 5_000 + 100);
    expect(await escaped.settle()).toEqual([]);
    expect(warningCodes(warnings)).toEqual(["frame_observer_failed"]);
    failing.now = false;
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([]);
  });
});

test("C-API-72 C-ATTN-12 a discovery failure while replaying to a late listener closes the request", async () => {
  const { session, events, id } = await listed();
  const failing = failOfferKeys();
  const escaped = escapedFailures();
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => {
    warnings.push(warning);
  });
  await closing(session, async () => {
    failing.now = true;
    const late: unknown[] = [];
    session.on("dialog", (event) => {
      late.push(event);
    });
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", "unavailable"],
      ]);
    expect(await escaped.settle()).toEqual([]);
    expect(warningCodes(warnings)).toEqual(["frame_observer_failed"]);
    expect(late).toHaveLength(1);
    failing.now = false;
    expect(await session.listDialogs()).toEqual([]);
  });
});
