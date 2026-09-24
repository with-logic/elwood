/**
 * Types for the serialized control queue: the submitter contract, the exclusive
 * task shape, cancellation, and a queued operation. Split from the queue class
 * to keep each file focused (PRD §5.3, C-API-19/37/44).
 */

import type { ControlOperationKind, ControlSubmitMode } from "./traits.ts";

// Writes an op to the terminal; resolves only once the submission (incl. any delayed
// Enter) has dispatched, so the next op never drains into a half-written composer.
// `signal` aborts on the NEXT op / on close (stops prior recovery nudges).
export type ControlSubmitter = (
  input: string,
  mode: ControlSubmitMode,
  signal: AbortSignal,
  onSubmitted?: () => void,
) => Promise<void>;

/** An abortable task run while its queue op holds the queue; aborts on close. */
export type AbortableQueueTask = (signal: AbortSignal) => Promise<void>;

/** Cancels queue wait and pre-operation cleanup; active exclusive tasks own their deadline. */
export type Cancel = { readonly signal: AbortSignal; readonly error: () => Error };

/** Internal provenance for activity and recurring-loop scheduling decisions. */
export type ControlSubmissionOrigin =
  | { readonly kind: "caller" }
  | { readonly kind: "loop"; readonly loopId: string };

/** Optional internal controls for an attributed, cancellable text submission. */
export type ControlSendOptions = {
  readonly cancel?: Cancel;
  /** Retain the active queue slot through close; either write outcome rejects with stoppedError. */
  readonly settleAfterWrite?: true;
  readonly origin?: ControlSubmissionOrigin;
};

type QueuedOperationBase = {
  readonly input: string;
  readonly settleAfterWrite?: boolean;
  readonly kind: ControlOperationKind;
  // FROZEN at enqueue: guidance queued before first readiness stays message-like (C-API-37).
  readonly mayBypassReadiness: boolean;
  readonly origin: ControlSubmissionOrigin;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

// The run/attach XOR: EITHER an exclusive-task op (e.g. `login`, holds the queue for
// its whole run; input unused) OR a text submission that may attach images before
// the write — never both, so dispatch never has to disambiguate (C-API-19/44). A
// caller cannot construct an op with both set (it fails to typecheck).
type RunOrAttach =
  | { readonly run: AbortableQueueTask; readonly attach?: never }
  | { readonly run?: never; readonly attach?: AbortableQueueTask };

export type QueuedOperation = QueuedOperationBase & RunOrAttach;

// A queued op before its resolve/reject are attached — the SAME run/attach XOR, so a
// pending op can no more carry both fields than a queued one can.
export type PendingOperation = Omit<QueuedOperationBase, "resolve" | "reject"> & RunOrAttach;

/**
 * Wrap preparation and one physical operation. The signal cancels pre-operation
 * cleanup; active exclusive work keeps its own lifetime. Origin identifies its owner.
 */
export type AdmissionWrapper = (
  work: () => Promise<void>,
  preparationSignal: AbortSignal,
  origin: ControlSubmissionOrigin,
) => Promise<void>;

/** Reserve queue order without occupying the physical input slot. */
export type ControlAdmission = {
  /** Fulfillment permits physical dispatch; rejection rejects and cancels the reservation. */
  readonly ready: Promise<void>;
  /** Wrap the queue's usual preparation and physical operation after admission is ready. */
  readonly run: AdmissionWrapper;
};
/**
 * The signal owns queued admission and aborts on cancellation, close, or setup failure.
 * Once run starts, its operation signal takes over; admission readiness is not completion.
 */
export type AdmitOperation = (
  origin: ControlSubmissionOrigin,
  signal: AbortSignal,
) => ControlAdmission | undefined;
