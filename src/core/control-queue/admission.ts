/** Park selected operations outside physical input while retaining ordering (PRD §5.9). */
import { toError } from "../errors.ts";
import type { AdmitOperation, ControlAdmission, QueuedOperation } from "./types.ts";

type Reservation = {
  readonly ticket: ControlAdmission;
  readonly abort: AbortController;
  ready: boolean;
};

export class ControlAdmissions {
  private readonly pending = new Map<QueuedOperation, Reservation>();
  private readonly admit: AdmitOperation | undefined;
  private readonly wake: () => void;
  private readonly fail: (operation: QueuedOperation, error: Error) => void;
  constructor(
    admit: AdmitOperation | undefined,
    wake: () => void,
    fail: (operation: QueuedOperation, error: Error) => void,
  ) {
    this.admit = admit;
    this.wake = wake;
    this.fail = fail;
  }

  get size(): number {
    return this.pending.size;
  }
  has(operation: QueuedOperation): boolean {
    return this.pending.has(operation);
  }
  waiting(operation: QueuedOperation): boolean {
    return this.pending.get(operation)?.ready === false;
  }

  prepare(operation: QueuedOperation): boolean {
    if (!this.admit || this.pending.has(operation)) return true;
    const abort = new AbortController();
    let ticket: ControlAdmission | undefined;
    try {
      ticket = this.admit(operation.origin, abort.signal);
    } catch (error) {
      this.fail(operation, toError(error));
      return false;
    }
    if (!ticket) return true;
    const reservation = { ticket, abort, ready: false };
    this.pending.set(operation, reservation);
    void ticket.ready.then(
      () => {
        if (!this.pending.has(operation)) return;
        reservation.ready = true;
        this.wake();
      },
      (error: unknown) => {
        if (this.pending.has(operation)) this.fail(operation, toError(error));
      },
    );
    return false;
  }

  take(operation: QueuedOperation): ControlAdmission | undefined {
    const ticket = this.pending.get(operation)?.ticket;
    this.pending.delete(operation);
    return ticket;
  }

  cancel(operation: QueuedOperation, error: Error): void {
    const reservation = this.pending.get(operation);
    this.pending.delete(operation);
    reservation?.abort.abort(error);
  }
}
