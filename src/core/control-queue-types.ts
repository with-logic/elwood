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

/** Runs an exclusive interactive task; aborted when the session closes. */
export type ExclusiveTask = (signal: AbortSignal) => Promise<void>;

/** Drops a still-queued op when `signal` aborts, rejecting it with `error()`. */
export type Cancel = { readonly signal: AbortSignal; readonly error: () => Error };

export type QueuedOperation = {
  readonly input: string;
  readonly kind: ControlOperationKind;
  // FROZEN at enqueue: guidance queued before first readiness stays message-like (C-API-37).
  readonly mayBypassReadiness: boolean;
  // EXCLUSIVE op (e.g. `login`): runs a task holding the queue for its whole duration (input unused).
  readonly run?: ExclusiveTask;
  // Attaches images through the adapter's native path BEFORE the text write, in
  // this same op so nothing interleaves; its failure fails the op (C-API-44).
  readonly attach?: ExclusiveTask;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};
