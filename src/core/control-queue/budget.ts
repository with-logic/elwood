/** Bound queued and active input ownership (PRD §5.3, C-API-58). */
import { elwoodError } from "../errors.ts";

export const inputQueueLimits = { operations: 1_024, bytes: 8 * 1_024 * 1_024 } as const;

function queueFullError() {
  return elwoodError(
    "input_queue_full",
    "Input would exceed the session's 1,024-operation or 8 MiB UTF-8 limit. Wait for pending input or reduce the input size.",
  );
}

/** Validate startup personas before side effects, and queued input before retention. */
export function checkedInputBytes(input: string, retainedBytes = 0): number {
  const bytes = Buffer.byteLength(input, "utf8");
  if (retainedBytes + bytes > inputQueueLimits.bytes) throw queueFullError();
  return bytes;
}

export class InputQueueBudget {
  private readonly reservations = new Map<object, number>();
  private bytes = 0;

  reserve(operation: { readonly input: string }): void {
    if (this.reservations.size >= inputQueueLimits.operations) throw queueFullError();
    const bytes = checkedInputBytes(operation.input, this.bytes);
    this.reservations.set(operation, bytes);
    this.bytes += bytes;
  }

  release(operation: object): void {
    // Loop fulfillment releases capacity before the later queue-ordering settlement.
    const bytes = this.reservations.get(operation);
    if (bytes === undefined) return;
    this.reservations.delete(operation);
    this.bytes -= bytes;
  }
}
