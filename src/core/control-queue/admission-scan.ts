/** Preserve actual reservation barriers across cached queue scans (PRD §5.3/§5.9). */
import type { ControlAdmissions } from "./admission.ts";
import { QueueScanCursor } from "./scan.ts";
import { controlOperationTraits, overtakesReadiness } from "./traits.ts";
import type { QueuedOperation } from "./types.ts";

export class AdmissionScan extends QueueScanCursor {
  // Describes only the cursor's skipped prefix, never its selected candidate.
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
      const reservedBefore = this.reservedPrefix;
      const hasReservation = admissions.has(operation);
      this.reservedPrefix ||= hasReservation;
      const mayCrossReservation =
        !admissions.waiting(operation) &&
        (!reservedBefore ||
          hasReservation ||
          !controlOperationTraits[operation.kind].reportsCallerSubmission);
      const mayCrossHold =
        mayCrossReservation && (!held || operation.origin.kind !== "loop" || hasReservation);
      const mayDispatch = mayCrossHold && (ready || overtakesReadiness(operation));
      // The selected operation is excluded from the cursor's cached prefix.
      if (mayDispatch) this.reservedPrefix = reservedBefore;
      return mayDispatch;
    });
  }
}
