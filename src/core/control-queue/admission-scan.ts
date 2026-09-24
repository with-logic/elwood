/** Preserve actual reservation barriers across cached queue scans (PRD §5.3/§5.9). */
import type { ControlAdmissions } from "./admission.ts";
import { QueueScanCursor } from "./scan.ts";
import { controlOperationTraits, overtakesReadiness } from "./traits.ts";
import type { QueuedOperation } from "./types.ts";

export class AdmissionScan extends QueueScanCursor {
  private reservedPrefix = false;

  override reset(): void {
    super.reset();
    this.reservedPrefix = false;
  }

  select(
    queue: readonly QueuedOperation[],
    admissions: ControlAdmissions,
    ready: boolean,
    held: boolean,
  ): number {
    return this.findIndex(queue, (operation) => {
      const before = this.reservedPrefix;
      const admitted = admissions.has(operation);
      this.reservedPrefix ||= admitted;
      const eligible =
        !admissions.waiting(operation) &&
        (!before || admitted || !controlOperationTraits[operation.kind].reportsCallerSubmission) &&
        (!held || operation.origin.kind !== "loop" || admitted) &&
        (ready || overtakesReadiness(operation));
      // The selected operation is excluded from the cursor's cached prefix.
      if (eligible) this.reservedPrefix = before;
      return eligible;
    });
  }
}
