/** Shared-state authority belongs to one launch generation (PRD §8.1, C-API-20). */
import { expect, test } from "vitest";
import { claimLaunchOwnership, revokeLaunchOwnership } from "../../src/state/launch-ownership.ts";

test("C-API-20 a successor and failed resume permanently revoke prior cleanup", () => {
  const first = claimLaunchOwnership("/session");
  expect(first.current()).toBe(true);
  revokeLaunchOwnership("/session");
  expect(first.current()).toBe(false);
  // A failed preflight need not create a successor to keep old cleanup revoked.
  first.release();
  expect(first.current()).toBe(false);
  const second = claimLaunchOwnership("/session");
  const third = claimLaunchOwnership("/session");
  expect(second.current()).toBe(false);
  second.release();
  expect(third.current()).toBe(true);
  third.release();
  expect(third.current()).toBe(false);
});
