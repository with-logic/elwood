/** Verify the live Codex workspace trust request for listing and delivery (C-ATTN-07, C-ATTN-08). */

import { runContained } from "../../core/contained.ts";
import type { ElwoodDialogEvent } from "../../core/dialogs/types.ts";
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import { boundedTrustEvidence } from "../../core/trust/evidence-deadline.ts";
import { settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { createTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu-frame.ts";
import type { CodexTrustDialogRequest } from "./types.ts";

type WorkspaceTrustRequestMetadata = {
  readonly request: CodexTrustDialogRequest;
  readonly declineOutcome: WorkspaceTrustFrame["menu"]["declineOutcome"];
};
type Retirement = Extract<ElwoodDialogEvent, { phase: "closed" }>["reason"];
type DiscoveryObserver = {
  readonly onListDiscovery: () => void;
  readonly onRetire: (request: CodexTrustDialogRequest, reason: Retirement) => void;
};
export class CodexWorkspaceTrustDiscovery {
  private readonly polling = new WorkspaceTrustPolling<"codex", WorkspaceTrustFrame>();
  private evidenceRevision = 0;
  private requestMetadata: WorkspaceTrustRequestMetadata | undefined;
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
  get currentRequestWithDeclineOutcome(): WorkspaceTrustRequestMetadata | undefined {
    const current = this.requestMetadata;
    return current?.request === this.polling.currentRequest ? current : undefined;
  }

  /** Retain the identity through repaint while reads and delivery verify independently. */
  get currentRequestId(): string | undefined {
    return this.polling.currentRequest?.id;
  }

  async list(): Promise<readonly CodexTrustDialogRequest[]> {
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

  async verifyRequestForAnswer(
    candidate: WorkspaceTrustFrame,
    signal: AbortSignal,
    stillCurrent: () => boolean,
    onAvailable?: () => void,
  ): Promise<"verified" | "expired" | undefined> {
    const revision = this.evidenceRevision;
    const proof = this.polling.collect(candidate.revalidateLaunchEvidence, signal, onAvailable);
    if (!proof) return undefined;
    const status = await proof.catch(() => "rejected" as const);
    if (signal.aborted || revision !== this.evidenceRevision || !stillCurrent()) return undefined;
    if (status === undefined) return "expired";
    if (status !== true) {
      this.retireUnverified();
      return undefined;
    }
    return "verified";
  }

  isRequestFrameCurrent({ frame, request }: VerifiedWorkspaceTrust<"codex">): boolean {
    return this.isRequestIdAtFrame(request.id, frame);
  }

  isRequestIdAtFrame(id: string, frame: TerminalSnapshot): boolean {
    return this.currentRequestId === id && this.canUseTrustFrame(frame);
  }

  /** Match captured launch evidence after polling closes. Callers must check the claimed menu identity. */
  matchObservedFrame(frame: TerminalSnapshot): WorkspaceTrustFrame | undefined {
    return this.match?.(this.input.terminal(), frame);
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
    const humanOwned = this.input.humanOwnedPrompt() === "workspace_trust";
    const prior = this.polling.currentRequest;
    if (!(humanOwned || prior)) return undefined;
    // An open request needs a close reason even when automation owns the next menu.
    const candidate = this.polling.sample(terminal, frame, this.match);
    if (prior && !this.polling.currentRequest)
      this.observer.onRetire(prior, candidate ? "replaced" : "unavailable");
    if (humanOwned) return candidate;
    this.retire("unavailable");
    return undefined;
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

    const verified = this.polling.acceptVerified(this.input.elwoodSessionId, candidate);
    this.requestMetadata = {
      request: verified.request,
      declineOutcome: candidate.menu.declineOutcome,
    };
    return verified;
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
