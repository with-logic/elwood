/** Deliver independently verified Codex workspace trust lifecycle events (C-ATTN-08). */
import { setImmediate } from "node:timers/promises";
import { observeDialogNotifications } from "../../core/warnings/dialogs.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { CodexEventMap } from "../session/types.ts";
import { CodexWorkspaceTrustDiscovery } from "./discovery.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import type { WorkspaceTrustFrame } from "./menu-frame.ts";
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "./types.ts";

type DialogListener = (event: ElwoodDialogEvent) => unknown;
type ClosedDialog = Extract<ElwoodDialogEvent, { phase: "closed" }>;
type PendingDeliveryCheck = {
  readonly candidate: WorkspaceTrustFrame;
  readonly replay: DialogListener | undefined;
  readonly cancellation: AbortController;
};

// Let a replacement proceed while one superseded native filesystem call settles.
const publicationCollectorLimit = 2;

export class CodexWorkspaceTrustEvents {
  readonly discovery: CodexWorkspaceTrustDiscovery;
  private readonly emitter: TypedEmitter<CodexEventMap>;
  private readonly observeNotifications: (deliver: () => void) => void;
  private readonly replays = new Set<DialogListener>();
  private pendingDeliveryCheck: PendingDeliveryCheck | undefined;
  private collecting = 0;
  private waitingForCollector = false;
  private announced: ElwoodDialogRequest | undefined;
  private closed: ClosedDialog | undefined;
  private needsRefresh = false;
  private publishing = false;

  constructor(
    input: WorkspaceTrustDiscoveryInput & {
      readonly emitter: TypedEmitter<CodexEventMap>;
      readonly isLive: () => boolean;
    },
  ) {
    const { emitter, isLive, ...discovery } = input;
    this.discovery = new CodexWorkspaceTrustDiscovery(discovery, {
      onListDiscovery: () => this.refresh(),
      onRetire: (request, reason) => this.retire(request, reason),
    });
    this.emitter = emitter;
    this.observeNotifications = observeDialogNotifications(
      emitter,
      { elwoodSessionId: input.elwoodSessionId, agent: "codex" },
      isLive,
    );
  }

  reconcileAfter(update: () => void): void {
    try {
      update();
    } finally {
      const candidate = this.discovery.reconcileCandidate();
      if (this.pendingDeliveryCheck && candidate !== this.pendingDeliveryCheck.candidate)
        this.pendingDeliveryCheck.cancellation.abort();
      if (candidate && (!this.announced || this.replays.size > 0)) this.refresh();
    }
  }

  readonly refreshAfterWorkspaceTrustTakeover = (): void => this.refresh();

  private readonly hasSubscribers = (): boolean => this.emitter.hasListeners("dialog");

  private refresh(): void {
    if (!this.hasSubscribers()) return;
    this.needsRefresh = true;
    this.schedulePublication();
  }

  private schedulePublication(): void {
    if (this.publishing) return;
    this.publishing = true;
    // Let the native frame dispatch and buffered registrations finish first.
    queueMicrotask(() => void this.publish().catch(this.discovery.retireUnverified));
  }

  private retire(request: ElwoodDialogRequest, reason: ClosedDialog["reason"]): void {
    if (this.announced !== request) return;
    this.announced = undefined;
    this.pendingDeliveryCheck?.cancellation.abort();
    this.replays.clear();
    this.closed = { phase: "closed", request, reason };
    this.schedulePublication();
  }

  listenerAdded(handler: DialogListener): void {
    if (this.announced) this.replays.add(handler);
    this.refresh();
  }

  listenerRemoved(handler: DialogListener): void {
    this.replays.delete(handler);
    const pending = this.pendingDeliveryCheck;
    if (!pending) return;
    const hasNoSubscribers = !this.hasSubscribers();
    const removedPendingReplayListener = pending.replay === handler;
    if (hasNoSubscribers || removedPendingReplayListener) {
      pending.cancellation.abort();
      if (this.replays.size > 0) this.refresh();
    }
  }

  private async publish(): Promise<void> {
    try {
      while (this.closed || this.needsRefresh) {
        if (this.closed) {
          const event = this.closed;
          this.closed = undefined;
          // A read that retired the request can deliver its result before host callbacks.
          await setImmediate();
          this.emit(event);
        }
        if (!this.needsRefresh) continue;
        this.needsRefresh = false;
        if (this.hasSubscribers()) await this.checkForDelivery();
      }
    } finally {
      this.publishing = false;
    }
  }

  private async checkForDelivery(): Promise<void> {
    const cancellation = new AbortController();
    try {
      const candidate = this.discovery.reconcileCandidate();
      const replay = this.replays.values().next().value;
      if (!candidate || (this.announced && !replay)) return;
      if (this.collecting === publicationCollectorLimit) {
        this.waitingForCollector = true;
        return;
      }
      this.pendingDeliveryCheck = { candidate, replay, cancellation };
      // Each distinct delivery obtains evidence after previous callbacks have run.
      const verified = await this.discovery.readForPublication(
        candidate,
        cancellation.signal,
        this.trackCollector,
      );
      if (
        cancellation.signal.aborted ||
        !verified ||
        !this.discovery.isRequestFrameCurrent(verified)
      )
        return;
      const { request } = verified;
      if (replay) {
        this.replays.delete(replay);
        const event = Object.freeze({ phase: "raised" as const, request });
        this.observeNotifications(() => this.emitter.notifyReplay(replay, event));
        this.needsRefresh ||= this.replays.size > 0;
      } else {
        this.announced = request;
        this.needsRefresh = false;
        this.emit({ phase: "raised", request });
      }
    } catch {
      if (!cancellation.signal.aborted) this.discovery.retireUnverified();
    } finally {
      this.pendingDeliveryCheck = undefined;
    }
  }

  private readonly trackCollector = (lookup: Promise<boolean>): void => {
    this.collecting += 1;
    const finish = () => {
      this.collecting -= 1;
      if (this.waitingForCollector) {
        this.waitingForCollector = false;
        this.refresh();
      }
    };
    // An aborted wait releases the publisher before a submitted filesystem call returns.
    void lookup.then(finish, finish);
  };

  private emit(event: ElwoodDialogEvent): void {
    this.observeNotifications(() => this.emitter.emit("dialog", Object.freeze(event), true));
  }
}
