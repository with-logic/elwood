/** Immutable first-read graceful authority (PRD §5.3, C-LIFE-10); no real signals. */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { watchDescendants } from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
import { errno, hook, LEADER, leaderRow } from "../helpers/scripted-process-tree.ts";

const epoch = Date.parse(`${leaderRow.startedAt} UTC`);
afterEach(() => vi.restoreAllMocks());

test.each([
  ["within start second", leaderRow, epoch + 999],
  ["unparseable start", { ...leaderRow, startedAt: "unreadable" }, epoch + 2_000],
  ["changed group", { ...leaderRow, pgid: LEADER + 1 }, epoch + 2_000],
])("C-LIFE-10 first observation refuses %s and cannot adopt a later row", (_name, row, started) => {
  const record = new DescendantRecord();
  expect(record.observeFirst([row, hook(5002)], LEADER, started)).toMatchObject({
    kind: "refused",
  });
  record.observe([leaderRow, hook(5002)], LEADER, true, epoch + 5_000);
  expect(record.known).toBe(false);
  expect(record.pids).toEqual([]);
});

test("C-LIFE-10 exact start-second boundary is old enough and freezes authority", () => {
  const record = new DescendantRecord();
  const observed = record.observeFirst([leaderRow], LEADER, epoch + 1_000);
  expect(observed).toEqual({ kind: "observed", identity: `${LEADER} ${leaderRow.startedAt}` });
  expect(record.refuseFirstObservation(errno("EIO"))).toBe(observed);
  expect(record.observeFirst([], LEADER, epoch + 2_000)).toBe(observed);
  record.observe([leaderRow, hook(5002)], LEADER, false, epoch + 2_000);
  expect(record.pids).toEqual([5002]);
});

test("C-LIFE-10 capture observation epoch before awaiting a slow first process read", async () => {
  const deferred = Promise.withResolvers<readonly (typeof leaderRow)[]>();
  const clock = vi.spyOn(Date, "now").mockReturnValue(epoch + 999);
  const watch = watchDescendants(LEADER, { listProcesses: () => deferred.promise }, () => false);
  clock.mockReturnValue(epoch + 2_000);
  deferred.resolve([leaderRow]);
  expect(await watch.firstObservation).toMatchObject({ kind: "refused" });
  expect((await watch.finish()).known).toBe(false);
});

test.each([
  errno("EIO"),
  Object.assign(new Error("secret path"), { code: "secret" }),
])("C-LIFE-10 a failed first read preserves safe errno without raw diagnostics", async (failure) => {
  const watch = watchDescendants(
    LEADER,
    { listProcesses: () => Promise.reject(failure) },
    () => true,
  );
  const first = await watch.firstObservation;
  expect(first.kind).toBe("refused");
  if (first.kind !== "refused") throw new Error("Expected refusal");
  expect(first.error.message).toBe("First leader process-table read failed.");
  expect("code" in first.error ? first.error.code : undefined).toBe(
    failure.message.includes("EIO") ? "EIO" : undefined,
  );
  expect((await watch.finish()).known).toBe(false);
});

test("C-LIFE-10 confirmed missing leader remains gone after a replacement appears", async () => {
  const watch = watchDescendants(LEADER, { listProcesses: () => Promise.resolve([]) }, () => false);
  expect(await watch.firstObservation).toEqual({ kind: "gone" });
  const record = await watch.finish();
  record.observe([leaderRow, hook(5002)], LEADER);
  expect(record.known).toBe(true);
  expect(record.pids).toEqual([]);
});

test("C-LIFE-10 the existing recording API never adopts an ambiguous initial leader", () => {
  const record = new DescendantRecord();
  vi.spyOn(Date, "now").mockReturnValue(epoch + 999);
  record.observe([leaderRow, hook(5002)], LEADER, true);
  expect(record.known).toBe(false);
  vi.spyOn(Date, "now").mockReturnValue(epoch + 5_000);
  record.observe([leaderRow, hook(5002)], LEADER);
  expect(record.known).toBe(false);
  expect(record.pids).toEqual([]);
});
