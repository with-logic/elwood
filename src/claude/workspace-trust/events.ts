/** Publish verified Claude trust events and replay each live registration (C-ATTN-08). */
import { runContained } from "../../core/contained.ts";
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "../../core/dialogs/types.ts";
import type { ClaudeEventMap } from "../../core/types.ts";
import { observeDialogNotifications } from "../../core/warnings/dialogs.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { ClaudeWorkspaceTrustDiscovery, type WorkspaceTrustDiscoveryInput } from "./discovery.ts";
import type { WorkspaceTrustFrame } from "./menu.ts";

type Event = ElwoodDialogEvent<"claude">;
type Request = ElwoodDialogRequest<"claude">;
type DialogListener = (event: Event) => unknown;
type PublicationInput = WorkspaceTrustDiscoveryInput & { readonly isLive: () => boolean };
type Retirement = Extract<Event, { phase: "closed" }>["reason"];
type Replay = { readonly request: Request; readonly isRegistered: () => boolean };
type PublicationProof = {
  readonly candidate: WorkspaceTrustFrame;
  readonly replay: DialogListener | undefined;
  readonly cancellation: AbortController;
};

export class ClaudeWorkspaceTrustEvents {
  private announced: Request | undefined;
  private pending = false;
  private draining = false;
  private readonly replays = new Map<DialogListener, Replay>();
  readonly discovery: ClaudeWorkspaceTrustDiscovery;
  private readonly emitter: TypedEmitter<ClaudeEventMap>;
  private readonly observeDelivery: (deliver: () => void) => void;
  private observerRevision = 0;
  private proof: PublicationProof | undefined;

  constructor(emitter: TypedEmitter<ClaudeEventMap>, input: PublicationInput) {
    this.emitter = emitter;
    this.observeDelivery = observeDialogNotifications(
      emitter,
      { elwoodSessionId: input.elwoodSessionId, agent: "claude" },
      input.isLive,
    );
    this.discovery = new ClaudeWorkspaceTrustDiscovery(input, {
      revision: () => this.observerRevision,
      onRetire: (request, reason) => this.retire(request, reason),
      onListDiscovery: (request) => {
        if (request !== this.announced) this.wake();
      },
    });
  }

  reconcile(): void {
    try {
      const candidate = this.discovery.observeNativeFrame();
      if (this.proof && this.proof.candidate !== candidate) this.proof.cancellation.abort();
      if (candidate) this.wake();
    } catch {
      if (this.announced) this.discovery.invalidateEvidence();
    }
  }

  reconcileAfter(update: () => void): void {
    try {
      update();
    } finally {
      this.reconcile();
    }
  }

  readonly onWorkspaceTrustTakeover = (): void => this.wake();

  private readonly wake = (): void => {
    if (!this.emitter.hasListeners("dialog")) return;
    this.pending = true;
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain().catch(this.discovery.invalidateEvidence);
    });
  };

  onListenerAdded(handler: DialogListener, isRegistered: () => boolean): void {
    // Listeners installed before announcement receive the ordinary event.
    if (this.announced) this.replays.set(handler, { request: this.announced, isRegistered });
    this.wake();
  }

  onListenerRemoved(handler: DialogListener): void {
    this.replays.delete(handler);
    if (this.proof && (this.proof.replay === handler || !this.emitter.hasListeners("dialog"))) {
      this.proof.cancellation.abort();
      if (this.replays.size > 0) this.wake();
    }
  }

  private retire(request: Request, reason: Retirement): void {
    if (this.announced !== request) return;
    this.announced = undefined;
    this.proof?.cancellation.abort();
    this.replays.clear();
    queueMicrotask(() => this.notify({ phase: "closed", request, reason }));
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        if (this.emitter.hasListeners("dialog")) await this.checkForDelivery();
      }
    } finally {
      this.draining = false;
    }
  }

  private async checkForDelivery(): Promise<void> {
    const cancellation = new AbortController();
    try {
      const candidate = this.discovery.reconcile();
      if (!candidate) return;
      const nextReplay = this.replays.entries().next().value;
      if (this.announced && !nextReplay) return;
      this.proof = { candidate, replay: nextReplay?.[0], cancellation };
      // A broadcast shares one proof. Each retained replay takes a fresh proof.
      const verified = await this.discovery.readForPublication(
        candidate,
        cancellation.signal,
        this.wake,
      );
      if (
        cancellation.signal.aborted ||
        !verified ||
        !this.discovery.isRequestFrameCurrent(verified)
      )
        return;
      if (nextReplay) {
        // Reconciliation clears queued replays when the announced request changes.
        this.deliverReplay(...nextReplay);
        this.pending ||= this.replays.size > 0;
      } else {
        this.announced = verified.request;
        this.notify({ phase: "raised", request: verified.request }, () =>
          this.discovery.isRequestFrameCurrent(verified),
        );
      }
    } catch {
      if (!cancellation.signal.aborted && this.announced) this.discovery.invalidateEvidence();
    } finally {
      this.proof = undefined;
    }
  }

  private deliverReplay(handler: DialogListener, replay: Replay): void {
    this.replays.delete(handler);
    if (!replay.isRegistered()) return;
    this.observerRevision++;
    this.observeDelivery(() =>
      this.emitter.notifyReplay(
        handler,
        Object.freeze({ phase: "raised", request: replay.request }),
      ),
    );
  }

  private notify(event: Event, stillCurrent?: () => boolean): void {
    runContained(() =>
      this.observeDelivery(() =>
        this.emitter.emit("dialog", Object.freeze(event), true, () => {
          if (stillCurrent?.() === false) return false;
          this.observerRevision++;
          return true;
        }),
      ),
    );
  }
}
