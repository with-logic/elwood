/**
 * A timed-out real-CLI wait names what the session had observed and keeps the original
 * error as its cause (the e2e diagnostics for C-API-65). Uses a real short timeout.
 */

import { expect, test } from "vitest";
import type { ObservedSession } from "../e2e/helpers.ts";
import { waitWithEvidence } from "../e2e/turn-failure.ts";

test("a timed-out wait reports the session's status and observations and keeps its cause", async () => {
  const observed: ObservedSession = {
    terminal: [],
    statuses: [],
    activities: [],
    hooks: [],
    warnings: [],
    hookErrors: [],
    transcripts: [],
    dispose: () => undefined,
  };
  const error = await waitWithEvidence(
    () => undefined,
    "the thing",
    10,
    { status: "ready" },
    observed,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const { message, cause } = error as Error;
  expect(message).toBe(
    "Timed out waiting for the thing; saw status ready; hooks ; activity ; warnings ; hook errors 0",
  );
  expect(cause).toEqual(new Error("Timed out waiting for the thing"));
});
