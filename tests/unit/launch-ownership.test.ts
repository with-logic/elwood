/** Shared-state reservations preserve failed launches without revoking successors (C-API-20). */
import { expect, test } from "vitest";
import { claimLaunchOwnership, reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";

test("C-API-20 pending resume reserves deletion but preserves prior ordinary loop writes", () => {
  const first = claimLaunchOwnership("/session");
  const pending = reserveLaunchOwnership("/session");
  expect(first.current()).toBe(false);
  expect(first.canPersist()).toBe(true);
  expect(pending.canPersist()).toBe(true);
  pending.rollback();
  expect(first.current()).toBe(true);
  expect(pending.canPersist()).toBe(false);
  first.release();
  expect(first.canPersist()).toBe(false);
});

test("C-API-20 a committed successor permanently revokes old authority", () => {
  const first = claimLaunchOwnership("/session");
  const pending = reserveLaunchOwnership("/session");
  pending.commit();
  expect(first.canPersist()).toBe(false);
  first.release();
  expect(pending.current()).toBe(true);
  pending.release();
});

test("C-API-20 rollback never replaces a newer claim and skips failed reservations", () => {
  const first = claimLaunchOwnership("/session");
  const older = reserveLaunchOwnership("/session");
  const newer = reserveLaunchOwnership("/session");
  older.rollback();
  expect(newer.current()).toBe(true);
  expect(first.canPersist()).toBe(true);
  newer.rollback();
  expect(first.current()).toBe(true);
  first.release();
  const empty = reserveLaunchOwnership("/session");
  empty.rollback();
  expect(empty.current()).toBe(false);
});

test("C-API-20 an earlier successful attempt can be restored after a newer failure", () => {
  const first = reserveLaunchOwnership("/session");
  const newer = reserveLaunchOwnership("/session");
  first.commit();
  expect(first.canPersist()).toBe(true);
  newer.rollback();
  expect(first.current()).toBe(true);
  first.release();
});
