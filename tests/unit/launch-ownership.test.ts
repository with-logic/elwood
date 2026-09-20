/** Shared-state reservations preserve failed launches without revoking successors (C-API-20). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-API-20 pending resume reserves deletion but preserves prior ordinary loop writes", () => {
  const first = reserveLaunchOwnership("/session");
  first.commit();
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
  const first = reserveLaunchOwnership("/session");
  first.commit();
  const pending = reserveLaunchOwnership("/session");
  pending.commit();
  expect(first.canPersist()).toBe(false);
  first.release();
  expect(pending.current()).toBe(true);
  pending.release();
});

test("C-API-20 rollback never replaces a newer claim and skips failed reservations", () => {
  const first = reserveLaunchOwnership("/session");
  first.commit();
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

test("C-API-20 owned record writes track pending publication and preserve intervening predecessor updates", () => {
  const path = tempDir();
  const file = join(path, "record");
  const prior = reserveLaunchOwnership(path);
  prior.commit();
  prior.publishFile(file, "original");
  const pending = reserveLaunchOwnership(path);
  expect(() => prior.publishFile(file, "stale")).toThrowError(
    expect.objectContaining({ code: "session_not_running" }),
  );
  pending.persistFile(file, "A");
  prior.persistFile(file, "B");
  pending.persistFile(file, "C");
  pending.rollback();
  expect(readFileSync(file, "utf8")).toBe("B");
  expect(() => pending.persistFile(file, "failed")).toThrowError(
    expect.objectContaining({ code: "session_not_running" }),
  );
  const successor = reserveLaunchOwnership(path);
  successor.commit();
  expect(() => prior.persistFile(file, "stale")).toThrowError(
    expect.objectContaining({ code: "session_not_running" }),
  );
  successor.release();
});

test("C-API-20 out-of-order failed publications restore the last viable launch's files", () => {
  const path = tempDir();
  const file = join(path, "bridge");
  const prior = reserveLaunchOwnership(path);
  prior.commit();
  prior.publishFile(file, "original");
  const older = reserveLaunchOwnership(path);
  older.publishFile(file, "older");
  const newer = reserveLaunchOwnership(path);
  newer.publishFile(file, "newer");
  older.rollback();
  expect(readFileSync(file, "utf8")).toBe("newer");
  newer.rollback();
  expect(readFileSync(file, "utf8")).toBe("original");
  expect(prior.current()).toBe(true);
  prior.release();
});
