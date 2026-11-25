/** Verify Claude's workspace trust menu for listing and publication (C-ATTN-07, C-ATTN-08). */
import { runContained } from "../../core/contained.ts";
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "../../core/dialogs/types.ts";
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustPromptIdFor } from "../../core/trust/prompts.ts";
import { settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { createClaudeWorkspaceTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu.ts";
import type { ClaudeLaunchTrustEvidence } from "./target.ts";

type DialogRequest = ElwoodDialogRequest<"claude">;
export type WorkspaceTrustDiscoveryInput = {
  readonly elwoodSessionId: string;
  readonly evidence: ClaudeLaunchTrustEvidence | undefined;
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptIdFor<"claude"> | undefined;
  readonly clearance: TrustClearance;
};

type Retirement = Extract<ElwoodDialogEvent<"claude">, { phase: "closed" }>["reason"];
type DiscoveryObserver = {
  readonly revision: () => number;
  readonly onRetire: (request: DialogRequest, reason: Retirement) => void;
  readonly onListDiscovery: (request: DialogRequest) => void;
};

export class ClaudeWorkspaceTrustDiscovery {
  private readonly polling = new WorkspaceTrustPolling<"claude", WorkspaceTrustFrame>();
  private readonly input: WorkspaceTrustDiscoveryInput;
  private readonly observer: DiscoveryObserver;
  private readonly match: ReturnType<typeof createClaudeWorkspaceTrustFrameMatcher> | undefined;

  constructor(input: WorkspaceTrustDiscoveryInput, observer: DiscoveryObserver) {
    this.input = input;
    this.observer = observer;
    this.match = input.evidence && createClaudeWorkspaceTrustFrameMatcher(input.evidence);
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    this.polling.bind(terminal, closing, this.invalidateEvidence);
  }

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

  async list(): Promise<readonly DialogRequest[]> {
    const prior = this.polling.currentRequest;
    while (true) {
      const revision = this.observer.revision();
      const verified = await this.read(revision);
      if (revision !== this.observer.revision()) continue;
      if (!(verified && this.isRequestFrameCurrent(verified))) return [];
      if (prior !== verified.request) this.observer.onListDiscovery(verified.request);
      return [verified.request];
    }
  }

  /** Track settled menu changes between polls without consulting the filesystem. */
  reconcile(): WorkspaceTrustFrame | undefined {
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

  private async read(revision: number): Promise<VerifiedWorkspaceTrust<"claude"> | undefined> {
    const candidate = this.reconcile();
    if (!candidate) return undefined;
    return await this.polling.read(
      candidate.frame,
      candidate.revalidateLaunchEvidence,
      (proved) => {
        // Only confirmed scope loss is authoritative across observer delivery.
        if (proved !== false && revision !== this.observer.revision()) return undefined;
        return this.acceptProof(candidate, proved);
      },
      revision,
    );
  }

  async readForPublication(
    candidate: WorkspaceTrustFrame,
    cancellation: AbortSignal,
    onAvailable: () => void,
  ): Promise<VerifiedWorkspaceTrust<"claude"> | undefined> {
    // Let a close queued by reconciliation deliver before collecting scope again.
    await Promise.resolve();
    const proof = this.polling.collect(
      candidate.revalidateLaunchEvidence,
      cancellation,
      onAvailable,
    );
    if (!proof) return undefined;
    const proved = await proof;
    return cancellation.aborted ? undefined : this.acceptProof(candidate, proved);
  }

  readonly invalidateEvidence = (): void => this.end("unavailable");

  private acceptProof(
    candidate: WorkspaceTrustFrame,
    proved: boolean | undefined,
  ): VerifiedWorkspaceTrust<"claude"> | undefined {
    // A completed Claude mismatch revokes the captured launch even after a repaint.
    if (proved === false) {
      this.end("unavailable");
      return undefined;
    }
    if (!this.canUseTrustFrame(candidate.frame)) return undefined;
    if (proved === undefined) {
      this.end("unavailable");
      return undefined;
    }

    return this.polling.acceptVerified("claude", this.input.elwoodSessionId, candidate);
  }

  isRequestFrameCurrent({ frame, request }: VerifiedWorkspaceTrust<"claude">): boolean {
    return this.polling.currentRequest === request && this.canUseTrustFrame(frame);
  }

  private canUseTrustFrame(frame: TerminalSnapshot): boolean {
    return this.polling.canUseTrustFrame(frame, this.input);
  }

  private end(reason: Retirement): void {
    this.retire(reason);
    this.polling.end();
  }

  private retire(reason: Retirement): void {
    const request = this.polling.currentRequest;
    this.polling.retire();
    if (request) this.observer.onRetire(request, reason);
  }
}
