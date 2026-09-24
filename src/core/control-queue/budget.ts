/** Bound queued and active input ownership (PRD §5.3, C-API-58). */
import { elwoodError } from "../errors.ts";

export const inputQueueLimits = { operations: 1_024, bytes: 8 * 1_024 * 1_024 } as const;

export class InputQueueBudget {
  private readonly reservations = new Map<object, number>();
  private bytes = 0;

  reserve(operation: { readonly input: string }): void {
    const bytes = Buffer.byteLength(operation.input, "utf8");
    if (
      this.reservations.size >= inputQueueLimits.operations ||
      this.bytes + bytes > inputQueueLimits.bytes
    )
      throw elwoodError("input_queue_full", "The session input queue is full.");
    this.reservations.set(operation, bytes);
    this.bytes += bytes;
  }

  release(operation: object): void {
    // Queue settlement/cancellation owns exactly one release for each admitted operation.
    const bytes = this.reservations.get(operation) as number;
    this.reservations.delete(operation);
    this.bytes -= bytes;
  }
}
