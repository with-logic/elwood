/**
 * Survivor-group ownership after SIGSTOP (PRD §5.3, C-LIFE-10). A group ID from an
 * earlier table is never enough for SIGKILL: retain its pre-signal member identities,
 * then require a fresh read to confirm a live, stopped anchor in that same group.
 */
import { errnoCode } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";
import type { DescendantRecord } from "./record.ts";
import type { SweepOps, SweepState } from "./rounds.ts";

export class SurvivorAnchors {
  private readonly members = new Map<number, ReadonlyMap<string, ProcessEntry>>();
  private readonly readAfterStop = new Set<number>();
  private readonly groupsWithStoppedOriginalAnchor = new Set<number>();
  private readonly rejectedGroups = new Set<number>();

  private readonly state: SweepState;
  private readonly record: DescendantRecord;
  private readonly ops: SweepOps;
  private byGroup = new Map<number, Map<string, ProcessEntry>>();

  constructor(state: SweepState, record: DescendantRecord, ops: SweepOps) {
    this.state = state;
    this.record = record;
    this.ops = ops;
  }

  /** Wraps SIGSTOP so its first successful send retains that table's member identities. */
  stoppingOps(): SweepOps {
    return {
      ...this.ops,
      stopGroup: (group) => {
        const members = new Map(this.byGroup.get(group));
        this.ops.stopGroup(group);
        if (!this.members.has(group)) this.members.set(group, members);
      },
    };
  }

  /** Reject unowned holds; restore only a freshly identified original member’s group. */
  afterRead(table: readonly ProcessEntry[]): void {
    this.byGroup = new Map();
    for (const row of table) {
      if (row.zombie) continue;
      const members = this.byGroup.get(row.pgid) ?? new Map<string, ProcessEntry>();
      members.set(processIdentity(row), row);
      this.byGroup.set(row.pgid, members);
    }
    const unsafe = this.record.unsafeSurvivorGroups(table);
    for (const [group, identities] of this.members) {
      this.readAfterStop.add(group);
      const anchors = [
        ...(this.byGroup.get(group) ?? new Map<string, ProcessEntry>()).values(),
      ].filter((row) => identities.has(processIdentity(row)));
      if (anchors.length === 0 || unsafe.has(group)) {
        this.restore(group);
      } else if (anchors.some((row) => row.stopped))
        this.groupsWithStoppedOriginalAnchor.add(group);
      else this.groupsWithStoppedOriginalAnchor.delete(group);
    }
  }

  /** A failed read or deadline cannot turn an unconfirmed SIGSTOP into authority to kill. */
  restoreUnconfirmed(): void {
    for (const group of this.members.keys()) {
      if (!this.groupsWithStoppedOriginalAnchor.has(group) || this.state.unheld.includes(group))
        this.restore(group);
    }
  }

  get rejected(): ReadonlySet<number> {
    return this.rejectedGroups;
  }

  private restore(group: number): void {
    this.state.failures.record(
      "a survivor group could not be safely confirmed stopped",
      undefined,
      [group],
    );
    this.rejectedGroups.add(group);
    const identities = this.members.get(group)!;
    this.members.delete(group);
    this.state.signaledGroupIds.delete(group);
    const index = this.state.signaledDescendantGroupIds.indexOf(group);
    this.state.signaledDescendantGroupIds.splice(index, 1);
    if (!this.readAfterStop.has(group)) {
      this.record.markUnknownResume();
      this.record.resumes.remember([...identities.values()], group);
      return;
    }
    const original = [...(this.byGroup.get(group)?.values() ?? [])].filter((row) =>
      identities.has(processIdentity(row)),
    );
    if (original.length === 0) {
      if (this.byGroup.has(group)) this.record.markUnknownResume();
      return;
    }
    try {
      this.ops.continueGroup(group);
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return;
      this.record.resumes.remember(original, group);
      this.state.failures.record("could not resume an unconfirmed survivor group", error, [group]);
    }
  }
}
