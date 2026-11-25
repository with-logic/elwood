/** Verify the live Codex workspace trust request for listing and delivery (C-ATTN-07, C-ATTN-08). */

import { runContained } from "../../core/contained.ts";
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import { boundedTrustEvidence } from "../../core/trust/evidence-deadline.ts";
import { settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { createTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu-frame.ts";
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "./types.ts";

type Retirement = Extract<ElwoodDialogEvent, { phase: "closed" }>["reason"];
type DiscoveryObserver = {
  readonly onListDiscovery: () => void;
  readonly onRetire: (request: ElwoodDialogRequest, reason: Retirement) => void;
};
export class CodexWorkspaceTrustDiscovery {
  private readonly polling = new WorkspaceTrustPolling<"codex", WorkspaceTrustFrame>();
  private evidenceRevision = 0;
  private readonly input: WorkspaceTrustDiscoveryInput;
  private readonly observer: DiscoveryObserver;
  private readonly match: ReturnType<typeof createTrustFrameMatcher> | undefined;

  constructor(input: WorkspaceTrustDiscoveryInput, observer: DiscoveryObserver) {
    this.input = input;
    this.observer = observer;
    this.match = input.evidence && createTrustFrameMatcher(input.evidence);
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    this.polling.bind(terminal, closing, () => this.end("unavailable"));
  }

  readonly retireUnverified = (): void => {
    this.evidenceRevision += 1;
    this.retire("unavailable");
  };

  endStartup(): void {
    let reason: Retirement = "unavailable";
    if (this.polling.currentRequest) {
      runContained(() => {
        const frame = settledNativeSnapshot(this.input.terminal());
        if (frame && this.input.clearance(frame.text)) reason = "cleared";
      });
    }
    this.end(reason);
  }
  /** Retain the identity through repaint while reads and delivery verify independently. */
  get currentRequestId(): string | undefined {
    return this.polling.currentRequest?.id;
  }

  async list(): Promise<readonly ElwoodDialogRequest[]> {
    const prior = this.currentRequestId;
    const verified = await this.read();
    if (!(verified && this.isRequestFrameCurrent(verified))) return [];
    if (prior !== verified.request.id) this.observer.onListDiscovery();
    return [verified.request];
  }

  private async read(): Promise<VerifiedWorkspaceTrust<"codex"> | undefined> {
    const candidate = this.reconcileCandidate();
    if (!candidate) return undefined;

    const revision = this.evidenceRevision;
    return await this.polling.read(candidate.frame, candidate.revalidateLaunchEvidence, (proved) =>
      this.accept(candidate, revision, proved),
    );
  }

  async readForPublication(
    candidate: WorkspaceTrustFrame,
    cancellation: AbortSignal,
    trackCollector: (lookup: Promise<boolean>) => void,
  ): Promise<VerifiedWorkspaceTrust<"codex"> | undefined> {
    const revision = this.evidenceRevision;
    const signal = AbortSignal.any([this.polling.signal, cancellation]);
    const proved = await boundedTrustEvidence((signal) => {
      const lookup = candidate.revalidateLaunchEvidence(signal);
      trackCollector(lookup);
      return lookup;
    }, signal);
    if (cancellation.aborted) return undefined;
    return this.accept(candidate, revision, proved);
  }

  isRequestFrameCurrent({ frame, request }: VerifiedWorkspaceTrust<"codex">): boolean {
    return this.currentRequestId === request.id && this.canUseTrustFrame(frame);
  }

  /** Reconcile the request lifetime and return a candidate from settled native output. */
  reconcileCandidate(): WorkspaceTrustFrame | undefined {
    if (this.polling.signal.aborted || !this.match) return undefined;
    const terminal = this.input.terminal();
    const frame = settledNativeSnapshot(terminal);
    if (!frame) return undefined;
    if (this.input.clearance(frame.text)) {
      this.end("cleared");
      return undefined;
    }
    if (this.input.humanOwnedPrompt() !== "workspace_trust") {
      this.retire("unavailable");
      return undefined;
    }
    const prior = this.polling.currentRequest;
    const candidate = this.polling.sample(terminal, frame, this.match);
    if (prior && !this.polling.currentRequest)
      this.observer.onRetire(prior, candidate ? "replaced" : "unavailable");
    return candidate;
  }

  private accept(
    candidate: WorkspaceTrustFrame,
    revision: number,
    proved: boolean | undefined,
  ): VerifiedWorkspaceTrust<"codex"> | undefined {
    if (revision !== this.evidenceRevision || !this.canUseTrustFrame(candidate.frame))
      return undefined;
    // Expiry ends discovery. A completed mismatch only retires this request.
    if (proved === undefined) {
      this.end("unavailable");
      return undefined;
    }
    if (proved === false) {
      this.retireUnverified();
      return undefined;
    }

    return this.polling.acceptVerified("codex", this.input.elwoodSessionId, candidate);
  }

  private canUseTrustFrame(frame: TerminalSnapshot): boolean {
    return this.polling.canUseTrustFrame(frame, this.input);
  }

  private end(reason: Retirement): void {
    const request = this.polling.currentRequest;
    this.polling.end();
    if (request) this.observer.onRetire(request, reason);
  }

  private retire(reason: Retirement): void {
    const request = this.polling.currentRequest;
    if (!request) return;
    this.polling.retire();
    this.observer.onRetire(request, reason);
  }
}
