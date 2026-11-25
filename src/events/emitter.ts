/** Typed session events and tool-keyed hook responses (PRD §5.4, §6.4, §7A.2). */
import { types } from "node:util";
import { runContained } from "../core/contained.ts";
import { inertRecord } from "../core/inert-record.ts";
import type { Unsubscribe } from "../core/types.ts";
import { ObserverErrors } from "./observer-errors.ts";

type Handler = (event: unknown) => unknown;
export type HandlerProvenance = "event" | "tool-keyed";
export type HandlerResponse = {
  readonly value: unknown;
  readonly provenance: HandlerProvenance;
};
type Registration = { readonly handler: Handler; readonly provenance: HandlerProvenance };
type EventKey<M> = Extract<keyof M, string>;
type HandlerFor<M, E extends EventKey<M>> = (event: M[E]) => unknown;

// Dispatch iterates a copy-on-write snapshot without allocating per event. Compare
// registrations against the live map because a handler may have been re-registered.
type Listeners = { list: readonly Registration[]; readonly live: Map<Handler, Registration> };

export class TypedEmitter<M extends Record<string, unknown>> {
  private readonly handlers: Map<EventKey<M>, Listeners>;
  private readonly observerErrors = new ObserverErrors();
  private observerError: ((error: unknown) => void) | undefined;
  private retainObserverError = false;
  private rejectionError: ((error: unknown) => void) | undefined;
  private allowRejectionReport: (() => boolean) | undefined;

  constructor() {
    this.handlers = new Map();
  }

  on<E extends EventKey<M>>(event: E, handler: HandlerFor<M, E>): Unsubscribe {
    this.listen(event, handler);
    return () => {
      this.off(event, handler);
    };
  }

  /** Register a listener and report whether this call added a new registration. */
  listen<E extends EventKey<M>>(
    event: E,
    handler: HandlerFor<M, E>,
    provenance: HandlerProvenance = "event",
  ): boolean {
    const entry = this.handlers.get(event);
    const h = handler as Handler;
    if (entry?.live.has(h)) return false;
    const registration = { handler: h, provenance };
    if (entry) {
      entry.live.set(h, registration);
      // Copy-on-write: a fresh array so any in-flight dispatch snapshot is unaffected.
      entry.list = [...entry.list, registration];
    } else {
      this.handlers.set(event, { list: [registration], live: new Map([[h, registration]]) });
    }
    return true;
  }

  off<E extends EventKey<M>>(event: E, handler: HandlerFor<M, E>): void {
    const entry = this.handlers.get(event);
    const h = handler as Handler;
    if (!entry?.live.delete(h)) return;
    // Copy-on-write removal keeps a concurrent `emit` snapshot stable; `live`
    // (already updated) makes the unsubscribe visible to that emission at once.
    entry.list = entry.list.filter((existing) => existing.handler !== h);
  }

  emit<E extends EventKey<M>>(event: E, payload: M[E], containRejections = false): void {
    const entry = this.handlers.get(event);
    if (!entry) return;
    // Deliver to every subscriber before surfacing any failure: one throwing
    // listener must not abort iteration and wedge an internal lifecycle
    // subscriber (e.g. interrupt/compact settling on a status transition, or
    // the transcript watcher's flush). The first error is rethrown after the
    // full fan-out, or captured by the active notification scope. The
    // `list` snapshot is immutable, so a listener added mid-emit does not fire
    // this round; `live` is consulted so one a prior handler removed is skipped.
    const snapshot = entry.list;
    const onError = this.observerError;
    const onRejection = this.rejectionSink(onError ?? this.rejectionError);
    let firstError: unknown;
    let failed = false;
    for (const registration of snapshot) {
      const { handler } = registration;
      if (entry.live.get(handler) !== registration) continue;
      try {
        this.notify(handler, payload, containRejections, onRejection);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) {
      if (onError) onError(firstError);
      else throw firstError;
    }
  }

  /** Deliver a replay to the single registration already checked by its owner. */
  notifyReplay<T>(handler: (payload: T) => unknown, payload: T): void {
    runContained(() => {
      const onError = this.observerError;
      try {
        this.notify(handler, payload, true, this.rejectionSink(onError));
      } catch (error) {
        onError?.(error);
      }
    });
  }

  private notify<T>(
    handler: (payload: T) => unknown,
    payload: T,
    containRejections: boolean,
    onRejection?: (error: unknown) => void,
  ): void {
    const returned = handler(payload);
    if ((onRejection || containRejections) && types.isPromise(returned)) {
      if (onRejection) this.observerErrors.observe(returned, onRejection, this.retainObserverError);
      else this.observerErrors.consume(returned);
    }
  }

  /** Capture synchronous throws and late Promise failures in this notification scope.
   * Pending Promises retain bounded diagnostic sinks after nested scopes unwind. */
  observeErrors<T>(
    onError: (error: unknown) => void,
    operation: () => T,
    retainOnOverflow = false,
  ): T {
    const previous = this.observerError;
    const priorRetention = this.retainObserverError;
    this.observerError = onError;
    this.retainObserverError = retainOnOverflow;
    try {
      return operation();
    } finally {
      this.observerError = previous;
      this.retainObserverError = priorRetention;
    }
  }

  /** Contain returned native Promise rejections while preserving synchronous throws.
   * The optional predicate is evaluated when a Promise rejects and may suppress the
   * report, including reports routed through an enclosing hook observer. */
  observeRejections<T>(
    onError: (error: unknown) => void,
    operation: () => T,
    allowReport?: () => boolean,
  ): T {
    const previous = this.rejectionError;
    const previousAllowance = this.allowRejectionReport;
    this.rejectionError = onError;
    this.allowRejectionReport = allowReport ?? previousAllowance;
    try {
      return operation();
    } finally {
      this.rejectionError = previous;
      this.allowRejectionReport = previousAllowance;
    }
  }

  private rejectionSink(sink: ((error: unknown) => void) | undefined) {
    const allowed = this.allowRejectionReport;
    if (!(sink && allowed)) return sink;
    return (error: unknown) => {
      if (allowed()) sink(error);
    };
  }

  hasListeners<E extends EventKey<M>>(event: E): boolean {
    return (this.handlers.get(event)?.live.size ?? 0) > 0;
  }

  async request<E extends EventKey<M>>(event: E, payload: M[E]): Promise<unknown> {
    return (await this.requestWithProvenance(event, payload))?.value;
  }

  /** Preserve the first responding registration's origin across async hook dispatch. */
  async requestWithProvenance<E extends EventKey<M>>(
    event: E,
    payload: M[E],
  ): Promise<HandlerResponse | undefined> {
    const entry = this.handlers.get(event);
    if (!entry) return undefined;
    for (const registration of entry.list) {
      const { handler, provenance } = registration;
      if (entry.live.get(handler) !== registration) continue;
      const returned = handler(payload);
      // Direct data must reach validation without Promise thenable assimilation.
      const value = types.isPromise(returned) ? await returned : returned;
      if (value !== undefined) return inertRecord({ value, provenance });
    }
    return undefined;
  }
}
