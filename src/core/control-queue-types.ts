/**
 * Types for the serialized control queue: the submitter contract, the exclusive
 * task shape, cancellation, and a queued operation. Split from the queue class
 * to keep each file focused (PRD §5.3, C-API-19/37/44).
 */

import type { ControlOperationKind, ControlSubmitMode } from "./control-queue-traits.ts";

// Writes an op to the terminal; resolves only once the submission (incl. any delayed
// Enter) has dispatched, so the next op never drains into a half-written composer.
// `signal` aborts on the NEXT op / on close (stops prior recovery nudges).
export type ControlSubmitter = (
  input: string,
  mode: ControlSubmitMode,
  signal: AbortSignal,
) => Promise<void>;

/** An abortable task run while its queue op holds the queue; aborts on close. */
export type AbortableQueueTask = (signal: AbortSignal) => Promise<void>;

/** Drops a still-queued op when `signal` aborts, rejecting it with `error()`. */
export type Cancel = { readonly signal: AbortSignal; readonly error: () => Error };

type QueuedOperationBase = {
  readonly input: string;
  readonly kind: ControlOperationKind;
  // FROZEN at enqueue: guidance queued before first readiness stays message-like (C-API-37).
  readonly mayBypassReadiness: boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

// A queued op is EITHER an exclusive-task op (e.g. `login`, holds the queue for
// its whole run; input unused) OR a text submission that may attach images before
// the write — never both, so dispatch never has to disambiguate (C-API-19/44).
export type QueuedOperation = QueuedOperationBase &
  (
    | { readonly run: AbortableQueueTask; readonly attach?: never }
    | { readonly run?: never; readonly attach?: AbortableQueueTask }
  );

// A queued op before its resolve/reject are attached. Both task fields are
// optional here (a constructor passes at most one); the stored op is the
// discriminated `QueuedOperation`, and dispatch checks `run`/`attach` directly.
export type PendingOperation = Omit<QueuedOperationBase, "resolve" | "reject"> & {
  readonly run?: AbortableQueueTask | undefined;
  readonly attach?: AbortableQueueTask | undefined;
};
