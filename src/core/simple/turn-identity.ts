/** Bind tagged collection only after the owned physical attempt (PRD §5.8, C-API-48). */
import type { BoundarySignal } from "./boundary-signal.ts";
import { onNativeBoundary } from "./native-boundary.ts";
import { captureNativeIdle } from "./native-idle.ts";
import { lastNativeTurn } from "./submission-context.ts";
import type { TurnBoundaryHook } from "./turn-types.ts";

/** The adapter owns native field names and normalization of the actual pasted payload. */
export type NativeTurnReader = {
  readonly prepareAcceptance: (payload: string) => (event: TurnBoundaryHook) => string | undefined;
};

export class TurnIdentity {
  private previous: string | undefined;
  private readAcceptance: ((event: TurnBoundaryHook) => string | undefined) | undefined;
  private accepted: string | undefined;
  private stopped = false;
  private rendered = false;
  private idleEvidence: ReturnType<typeof captureNativeIdle>;
  private readonly session: object;
  private readonly reader: NativeTurnReader;
  constructor(session: object, reader: NativeTurnReader) {
    this.session = session;
    this.reader = reader;
  }
  /** Called before actual Enter, including when its physical write promise is still pending. */
  beforeEnter = (payload: string): void => {
    if (!this.readAcceptance) {
      this.previous = lastNativeTurn(this.session);
      this.idleEvidence = captureNativeIdle(this.session);
      this.readAcceptance = this.reader.prepareAcceptance(payload);
    }
  };
  get attempted(): boolean {
    return this.readAcceptance !== undefined;
  }
  observe(event: TurnBoundaryHook): boolean {
    const id = this.readAcceptance?.(event);
    if (id !== undefined && id !== this.previous) this.accepted ??= id;
    return this.accepted !== undefined;
  }
  ready(): boolean {
    return this.rendered
      ? this.idleEvidence?.isReady() === true
      : this.stopped && this.idleEvidence?.isIdle() === true;
  }
  get hooklessCompleted(): boolean {
    return this.rendered;
  }
  observeBoundary(stopped: (signal: BoundarySignal) => void, idle: () => void): () => void {
    let offIdle: () => void = () => undefined;
    const offStop = onNativeBoundary(this.session, (boundary) => {
      if (boundary.kind === "rendered") {
        if (this.accepted !== undefined && this.idleEvidence?.isReady()) {
          this.rendered = true;
          idle();
        }
        return;
      }
      if (!this.accepts(boundary.turnId)) return;
      this.stopped = true;
      offIdle();
      offIdle =
        this.idleEvidence?.onIdle(() => {
          idle();
        }) ?? (() => undefined);
      stopped(boundary.signal);
    });
    return () => {
      offStop();
      offIdle();
    };
  }
  acceptsContent(turnId: string | undefined): boolean {
    return this.accepted !== undefined && (turnId === undefined || turnId === this.accepted);
  }
  accepts(turnId: string | undefined): boolean {
    return this.accepted !== undefined && turnId === this.accepted;
  }
}
