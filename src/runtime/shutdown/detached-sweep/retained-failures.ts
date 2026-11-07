/** Retain failed shutdown observations until every record resolves (PRD §9.4, C-LIFE-10). */
import { errnoCode } from "../../../core/errors.ts";
import type { ProcessTreeOps } from "../process-tree-ops.ts";
import type { ReapQueue } from "../reap-queue.ts";
import { type BackgroundReap, reapInBackground } from "./background.ts";
import type { SweepFailure } from "./failures.ts";
import type { DescendantRecord } from "./record.ts";

export class RetainedShutdownFailures {
  private readonly recoveries: BackgroundReap[] = [];
  private failure: SweepFailure | undefined;
  private retainedHistory = false;
  private readonly ops: ProcessTreeOps;
  private readonly serialize: ReapQueue;

  constructor(ops: ProcessTreeOps, serialize: ReapQueue) {
    this.ops = ops;
    this.serialize = serialize;
  }

  /** History survives resolution, so confirmation cannot regain numeric signal authority. */
  get hasRetainedHistory(): boolean {
    return this.retainedHistory;
  }

  /** The attempt that failed still rejects, even when its recovery finishes immediately. */
  keep(failure: SweepFailure | undefined, record: DescendantRecord): void {
    if (failure === undefined) return;
    this.retainedHistory = true;
    this.failure ??= failure;
    const ops = {
      ...this.ops,
      continueGroup: (group: number) => {
        try {
          this.ops.continueGroup(group);
        } catch (error) {
          if (errnoCode(error) === "ESRCH") record.markGroupGone(group);
          throw error;
        }
      },
    };
    this.recoveries.push(
      reapInBackground(
        record,
        {
          ...ops,
          listProcesses: this.ops.listProcessesUnreferenced ?? this.ops.listProcesses,
        },
        this.serialize,
        ops,
      ),
    );
    throw failure;
  }

  /**
   * Only expired records admit fresh referenced checks. Fulfillment means checking
   * finished or timed out; callers must use throwIfUnresolved() before reporting success.
   */
  confirm(): Promise<void> | undefined {
    const pending = this.recoveries
      .map((recovery) => recovery.confirm())
      .filter((read) => read !== undefined);
    if (pending.length === 0) return undefined;
    return Promise.all(pending).then(() => undefined);
  }

  /** A later call clears the original failure only when every retained record is resolved. */
  throwIfUnresolved(): void {
    if (this.recoveries.every((recovery) => recovery.resolved())) {
      this.failure = undefined;
      this.recoveries.length = 0;
    }
    if (this.failure !== undefined) throw this.failure;
  }
}
