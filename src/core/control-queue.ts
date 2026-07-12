/**
 * Typed control-operation queue for adapter sessions: caller messages and
 * TUI slash-command operations share one submission lifecycle with
 * per-operation readiness semantics.
 * Implements PRD §5.3 and C-API-19.
 */

export type ControlQueueError = () => Error;
export type ControlSubmitMode = "message" | "command";
export type ControlOperationKind =
  | "message"
  | "readiness_bypass"
  | "compact"
  | "list_models"
  | "set_model";

export type ControlOperationTraits = {
  /** Whether submitting this operation starts a user turn. */
  readonly startsTurn: boolean;
  /** Whether submission consumes queue readiness until the next ready mark. */
  readonly consumesReadiness: boolean;
  /**
   * Whether the operation waits for queue readiness before dispatching.
   * Messages and `compact` run after the active turn completes (C-API-22);
   * picker automation (`list_models`/`set_model`) is transient TUI control
   * that must dispatch even mid-turn, or an in-flight turn (e.g. an MCP boot
   * spinner) would stall it.
   */
  readonly waitsForReadiness: boolean;
  /** How the operation's input is written to the terminal. */
  readonly submitMode: ControlSubmitMode;
};

/**
 * Slash-command operations do not start a user turn, so no completion hook
 * will re-arm readiness afterwards; consuming readiness would deadlock later
 * sends.
 */
export const controlOperationTraits: Readonly<
  Record<ControlOperationKind, ControlOperationTraits>
> = {
  message: {
    startsTurn: true,
    consumesReadiness: true,
    waitsForReadiness: true,
    submitMode: "message",
  },
  readiness_bypass: {
    startsTurn: true,
    consumesReadiness: true,
    waitsForReadiness: false,
    submitMode: "message",
  },
  compact: {
    startsTurn: false,
    consumesReadiness: false,
    waitsForReadiness: true,
    submitMode: "command",
  },
  list_models: {
    startsTurn: false,
    consumesReadiness: false,
    waitsForReadiness: false,
    submitMode: "command",
  },
  set_model: {
    startsTurn: false,
    consumesReadiness: false,
    waitsForReadiness: false,
    submitMode: "command",
  },
};

/**
 * Writes an operation to the terminal. Resolves only once the submission —
 * including any delayed Enter keystroke — has been dispatched, so the queue
 * does not drain the next operation into a half-written composer.
 */
export type ControlSubmitter = (input: string, mode: ControlSubmitMode) => Promise<void>;

type QueuedOperation = {
  readonly input: string;
  readonly kind: ControlOperationKind;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

export class ControlQueue {
  private readonly queue: QueuedOperation[] = [];
  private readonly submit: ControlSubmitter;
  private readonly stoppedError: ControlQueueError;
  private readonly onTurnStarted: () => void;
  private ready = false;
  private everReady = false;
  private closed = false;
  /** The operation whose submission (incl. delayed Enter) is still dispatching. */
  private inFlight: QueuedOperation | undefined;

  constructor(
    submit: ControlSubmitter,
    stoppedError: ControlQueueError,
    onTurnStarted: () => void,
  ) {
    this.submit = submit;
    this.stoppedError = stoppedError;
    this.onTurnStarted = onTurnStarted;
  }

  send(input: string, kind: ControlOperationKind): Promise<void> {
    if (this.closed) return Promise.reject(this.stoppedError());
    return new Promise((resolve, reject) => {
      this.queue.push({ input, kind, resolve, reject });
      this.drain();
    });
  }

  markReady(): void {
    if (this.closed) return;
    this.everReady = true;
    this.ready = true;
    this.drain();
  }

  hasBeenReady(): boolean {
    return this.everReady;
  }

  /**
   * Suspends readiness so readiness-waiting operations (messages, compact)
   * hold until the next `markReady`. Used both when a turn starts and when a
   * blocking dialog appears; it implies no new turn on its own.
   */
  suspendReadiness(): void {
    this.ready = false;
  }

  close(): void {
    this.closed = true;
    const error = this.stoppedError();
    // Reject the still-dispatching operation too: closing while a command's
    // delayed Enter is pending must fail it immediately with the stopped
    // error, not let it later resolve or time out downstream.
    const settling = this.inFlight;
    this.inFlight = undefined;
    if (settling) settling.reject(error);
    for (const operation of this.queue.splice(0)) operation.reject(error);
  }

  private drain(): void {
    if (this.inFlight || this.queue.length === 0) return;
    // A readiness-bypassing submission may overtake a waiting head;
    // all other operations retain FIFO and their readiness semantics.
    const next = this.queue[0] as QueuedOperation;
    const headWaits = controlOperationTraits[next.kind].waitsForReadiness && !this.ready;
    const index = headWaits ? this.queue.findIndex(({ kind }) => kind === "readiness_bypass") : 0;
    if (index < 0) return;
    const operation = this.queue.splice(index, 1)[0] as QueuedOperation;
    let dispatched: Promise<void>;
    try {
      dispatched = this.submitNow(operation.input, operation.kind);
    } catch (error) {
      operation.reject(asError(error));
      this.drain();
      return;
    }
    // The write (incl. any delayed command Enter) holds the next drain so
    // back-to-back queued operations never interleave in the terminal. The
    // caller settles with the write's outcome; if close() already settled this
    // operation, the handlers no-op (inFlight was cleared).
    this.inFlight = operation;
    dispatched.then(
      () => this.settleInFlight(operation, () => operation.resolve()),
      (error: unknown) => this.settleInFlight(operation, () => operation.reject(asError(error))),
    );
  }

  private settleInFlight(operation: QueuedOperation, settle: () => void): void {
    // close() may have already rejected and cleared this operation.
    if (this.inFlight !== operation) return;
    this.inFlight = undefined;
    settle();
    this.drain();
  }

  /** Writes the operation and returns a promise for when its write fully lands. */
  private submitNow(input: string, kind: ControlOperationKind): Promise<void> {
    const traits = controlOperationTraits[kind];
    if (traits.consumesReadiness) this.ready = false;
    const dispatched = this.submit(input, traits.submitMode);
    if (traits.startsTurn) this.onTurnStarted();
    return dispatched;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
