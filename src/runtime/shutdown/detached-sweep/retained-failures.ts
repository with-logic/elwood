/** Retain failed shutdown observations until every record resolves (PRD §9.4, C-LIFE-10). */
import type { ProcessTreeOps } from "../process-tree-ops.ts";
import type { ReapQueue } from "../reap-queue.ts";
import { type BackgroundReap, reapInBackground } from "./background.ts";
import type { SweepFailure } from "./failures.ts";
import type { DescendantRecord } from "./record.ts";

export class RetainedShutdownFailures {
  private readonly recoveries: BackgroundReap[] = [];
  private failure: SweepFailure | undefined;
  private readonly ops: ProcessTreeOps;
  private readonly serialize: ReapQueue;

  constructor(ops: ProcessTreeOps, serialize: ReapQueue) {
    this.ops = ops;
    this.serialize = serialize;
  }

  /** The attempt that failed still rejects, even when its recovery finishes immediately. */
  keep(failure: SweepFailure | undefined, record: DescendantRecord): void {
    if (failure === undefined) return;
    this.failure ??= failure;
    this.recoveries.push(
      reapInBackground(
        record,
        {
          ...this.ops,
          listProcesses: this.ops.listProcessesUnreferenced ?? this.ops.listProcesses,
        },
        this.serialize,
        this.ops,
      ),
    );
    throw failure;
  }

  /** Only expired records admit a fresh, referenced confirmation. */
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
