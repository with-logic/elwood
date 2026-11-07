/** Platform timestamp uncertainty cannot authorize newly born identities (PRD §5.3, C-LIFE-10). */
import { expect, test } from "vitest";
import { setPlatformForTests } from "../../src/runtime/seams.ts";
import { observeLeader } from "../../src/runtime/shutdown/detached-sweep/leader-observation.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { hook, LEADER, leaderRow } from "../helpers/scripted-process-tree.ts";

const epoch = Date.parse(`${leaderRow.startedAt} UTC`);

test.each([
  { platform: "darwin", elapsed: 999, kind: "refused" },
  { platform: "darwin", elapsed: 1000, kind: "observed" },
  { platform: "linux", elapsed: 1000, kind: "refused" },
  { platform: "linux", elapsed: 1001, kind: "refused" },
  { platform: "linux", elapsed: 1500, kind: "refused" },
  { platform: "linux", elapsed: 1999, kind: "refused" },
  { platform: "linux", elapsed: 2000, kind: "observed" },
])("C-LIFE-10 $platform first leader at reported start +$elapsed ms is $kind", ({
  platform,
  elapsed,
  kind,
}) => {
  setPlatformForTests(platform);
  expect(observeLeader(leaderRow, LEADER, epoch + elapsed).kind).toBe(kind);
});

test.each([
  { elapsed: 1999, ambiguous: true },
  { elapsed: 2000, ambiguous: false },
])("C-LIFE-10 Linux retained member at +$elapsed ms preserves ambiguity=$ambiguous", ({
  elapsed,
  ambiguous,
}) => {
  setPlatformForTests("linux");
  const child = hook(5002);
  const record = new DescendantRecord();
  record.observeGroups([child], new Map([[child.pgid, new Set([child])]]), epoch + elapsed);
  // Later age cannot turn a first-seen ambiguous identity into signaling authority.
  record.observeGroups([child], new Map([[child.pgid, new Set([child])]]), epoch + 10_000);
  expect(record.unsafeSurvivorGroups([child]).has(child.pgid)).toBe(ambiguous);
});
