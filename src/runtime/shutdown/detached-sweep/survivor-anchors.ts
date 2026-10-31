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
  private readonly members = new Map<number, ReadonlySet<string>>();
  private readonly readAfterStop = new Set<number>();
  private readonly confirmed = new Set<number>();

  private readonly state: SweepState;
  private readonly record: DescendantRecord;
  private readonly ops: SweepOps;
  private readonly background: boolean;

  constructor(state: SweepState, record: DescendantRecord, ops: SweepOps, background: boolean) {
    this.state = state;
    this.record = record;
    this.ops = ops;
    this.background = background;
  }

  /** Wraps SIGSTOP so its first successful send retains that table's member identities. */
  stoppingOps(): SweepOps {
    return {
      ...this.ops,
      stopGroup: (group) => {
        const members = new Set(
          this.state.latest.filter((row) => !row.zombie && row.pgid === group).map(processIdentity),
        );
        this.ops.stopGroup(group);
        if (!this.members.has(group)) this.members.set(group, members);
      },
    };
  }

  /** Rejects and restores any stopped group whose pre-signal member no longer anchors it. */
  afterRead(table: readonly ProcessEntry[]): boolean {
    let matched = true;
    const blocked = this.background ? this.record.unsafeBackgroundGroups(table) : new Set<number>();
    for (const [group, identities] of this.members) {
      this.readAfterStop.add(group);
      const anchors = table.filter(
        (row) => !row.zombie && row.pgid === group && identities.has(processIdentity(row)),
      );
      if (anchors.length === 0 || blocked.has(group)) {
        this.restore(group);
        matched = false;
      } else if (anchors.some((row) => row.stopped)) this.confirmed.add(group);
      else this.confirmed.delete(group);
    }
    return matched;
  }

  /** A failed read or deadline cannot turn an unconfirmed SIGSTOP into authority to kill. */
  restoreUnconfirmed(): void {
    for (const group of this.members.keys()) {
      if (!this.confirmed.has(group) || this.state.unheld.includes(group)) this.restore(group);
    }
  }

  private restore(group: number): void {
    this.state.failures.record("a survivor group lost its identity anchor", undefined, [group]);
    this.members.delete(group);
    this.state.signaledGroupIds.delete(group);
    const index = this.state.signaledDescendantGroupIds.indexOf(group);
    this.state.signaledDescendantGroupIds.splice(index, 1);
    try {
      this.ops.continueGroup(group);
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return;
      const table = this.state.latest;
      if (this.readAfterStop.has(group) && table.some((row) => !row.zombie && row.pgid === group))
        this.record.resumes.remember(table, group);
      else this.record.markUnknownResume();
      this.state.failures.record("could not resume an unconfirmed survivor group", error, [group]);
    }
  }
}
