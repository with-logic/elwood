/**
 * Lists and announces the Codex update offer while no Elwood skip answers it
 * (PRD §5.13 "Codex update offers", C-ATTN-12). Its delivery is its own rather than the
 * trust dialogs': a trust request is published only after its filesystem evidence is
 * verified, with delivery revisions for the writer, while an offer is read from the
 * settled frame alone. Both deliver through the session's one `observeNotifications`.
 */
import type { ElwoodDialogEvent, ElwoodUpdateDialogRequest } from "../../core/dialogs/types.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import {
  nativeRenderEvidenceIntact,
  onNativeRenderEvidenceInvalidated,
  settledLiveSnapshot,
} from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { CodexEventMap } from "../session/types.ts";
import type { SettledCodexStartupOutcome } from "../startup-prompts.ts";
import {
  type CodexUpdateOffer,
  createCodexUpdateDialogRequest,
  readCodexUpdateOffer,
} from "./dialog-request.ts";
import { updateScreenBanner } from "./layout.ts";

type DialogListener = (event: ElwoodDialogEvent) => unknown;
type CloseReason = Extract<ElwoodDialogEvent, { phase: "closed" }>["reason"];

/**
 * Why a listed request ends on `frame`. Codex took the offer away only when its banner is
 * gone; a partial or ambiguous offer, or one a new skip answers, still shows it.
 */
function closeReason(offer: CodexUpdateOffer | undefined, frame: string): CloseReason {
  if (offer) return "replaced";
  if (updateScreenBanner.test(frame)) return "unavailable";
  return "cleared";
}

type CodexUpdateDialogsInput = {
  readonly elwoodSessionId: string;
  readonly emitter: TypedEmitter<CodexEventMap>;
  readonly terminal: () => ElwoodTerminal;
  /**
   * The trust dialogs' delivery, shared by every session dialog: it reports one listener
   * failure per session, and the trust writer resumes once any dialog's listeners have run.
   */
  readonly observeNotifications: (deliver: () => void) => void;
  /** The session's one `frame_observer_failed` report (C-API-72). */
  readonly reportFailure: () => void;
};

export class CodexUpdateDialogs {
  private readonly input: CodexUpdateDialogsInput;
  private current:
    | { readonly request: ElwoodUpdateDialogRequest; readonly key: string }
    | undefined;
  private announced: ElwoodDialogEvent["request"] | undefined;
  // The settlement of the Elwood skip answering the offer, until it settles.
  private skip: Promise<unknown> | undefined;
  private readonly events: ElwoodDialogEvent[] = [];
  private readonly replays = new Set<DialogListener>();
  private delivering = false;
  private discoveryEnded = false;

  constructor(input: CodexUpdateDialogsInput) {
    this.input = input;
  }

  list(): readonly ElwoodUpdateDialogRequest[] {
    this.reconcile();
    return this.current ? [this.current.request] : [];
  }

  /** Each frame: an update skip that starts here owns the offer until it settles. */
  observe(outcomes: readonly SettledCodexStartupOutcome[]): void {
    for (const item of outcomes) {
      if (item.outcome.kind !== "attempted" || item.outcome.prompt !== "update") continue;
      // An attempted outcome always carries `settled`, but checking the nested `kind` does
      // not narrow `item`, whose type still allows the pending outcome's `undefined`.
      const skip = Promise.resolve(item.settled);
      this.skip = skip;
      const handOver = () => {
        if (this.skip === skip) this.skip = undefined;
        this.reconcile();
      };
      void skip.then(handOver, handOver);
    }
    this.reconcile();
  }

  /** Lost native evidence ends the request without waiting for a frame; closing ends discovery. */
  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    const stop = onNativeRenderEvidenceInvalidated(terminal, this.reconcile);
    closing.addEventListener(
      "abort",
      () => {
        stop();
        this.endDiscovery();
      },
      { once: true },
    );
  }

  /**
   * Retires any listed request and stops discovery for good: readiness or closure ends the
   * startup window that Codex draws its offer in.
   */
  endDiscovery(): void {
    this.retire("unavailable");
    this.discoveryEnded = true;
  }

  /** A listener added after the announcement gets the current request; earlier ones share it. */
  listenerAdded(handler: DialogListener): void {
    if (!this.current || this.announced !== this.current.request) return;
    this.replays.add(handler);
    this.scheduleDelivery();
  }

  listenerRemoved(handler: DialogListener): void {
    this.replays.delete(handler);
  }

  /**
   * Every path into discovery runs here: a frame, a settled skip, lost evidence, a replay and
   * a list call. A failure is reported once per session and ends discovery (C-API-72).
   */
  readonly reconcile = (): void => {
    if (this.discoveryEnded) return;
    try {
      this.reconcileFrame();
    } catch {
      this.input.reportFailure();
      this.endDiscovery();
    }
  };

  private reconcileFrame(): void {
    const terminal = this.input.terminal();
    // Host output or a viewport change ends native evidence for the life of the terminal.
    if (!nativeRenderEvidenceIntact(terminal)) {
      this.endDiscovery();
      return;
    }
    const frame = settledLiveSnapshot(terminal)?.text;
    if (frame === undefined) return; // an unsettled repaint keeps the request
    const offer = this.skip ? undefined : readCodexUpdateOffer(frame);
    const key = offer && JSON.stringify(offer);
    if (key === this.current?.key) return;
    this.retire(closeReason(offer, frame));
    if (!(offer && key)) return;
    const request = createCodexUpdateDialogRequest(this.input.elwoodSessionId, offer);
    this.current = { request, key };
    this.queue({ phase: "raised", request });
  }

  private retire(reason: CloseReason): void {
    const request = this.current?.request;
    if (!request) return;
    this.current = undefined;
    this.replays.clear();
    this.queue({ phase: "closed", request, reason });
  }

  private queue(event: ElwoodDialogEvent): void {
    this.events.push(Object.freeze(event));
    this.scheduleDelivery();
  }

  // Listeners run after the frame that changed the request, never inside terminal processing.
  private scheduleDelivery(): void {
    if (this.delivering) return;
    this.delivering = true;
    queueMicrotask(() => {
      this.delivering = false;
      for (let event = this.events.shift(); event; event = this.events.shift()) {
        const dispatched = event;
        if (dispatched.phase === "raised") this.announced = dispatched.request;
        this.input.observeNotifications(() => this.input.emitter.emit("dialog", dispatched, true));
      }
      this.replay();
    });
  }

  private replay(): void {
    this.reconcile(); // a retired or replaced request clears the replays
    if (!this.current) return;
    const event = Object.freeze({ phase: "raised" as const, request: this.current.request });
    // A listener a replayed one adds waits for the next delivery, which reads the frame first;
    // one removed, or a request retired, meanwhile skips the rest of this batch.
    for (const handler of [...this.replays]) {
      if (!this.replays.delete(handler)) continue;
      this.input.observeNotifications(() => this.input.emitter.notifyReplay(handler, event));
    }
  }
}
