/** Discover and answer Claude workspace trust with settled native and Git evidence (C-ATTN-07). */
import { runContained } from "../../core/contained.ts";
import type { ElwoodDialogAnswerOptions } from "../../core/dialogs/types.ts";
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import type { PtyExit } from "../../pty/types.ts";
import { nativeRenderEvidenceIntact, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { type ClaudeTrustAppearance, claudeTrustWriter, openClaudeTrustAnswer } from "./answer.ts";
import { verifyClaudeTrustAnswer } from "./answer-proof.ts";
import type {
  DialogRequest,
  DiscoveryObserver,
  Retirement,
  WorkspaceTrustDiscoveryInput,
} from "./discovery-input.ts";
import { createClaudeWorkspaceTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu.ts";
import { ClaudeTrustNativeAppearance } from "./native-appearance.ts";

export type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";

export class ClaudeWorkspaceTrustDiscovery {
  private answerRequest: ReturnType<typeof openClaudeTrustAnswer> | undefined;
  private readonly writer;
  private readonly nativeAppearance = new ClaudeTrustNativeAppearance();
  private readonly polling = new WorkspaceTrustPolling<"claude", WorkspaceTrustFrame>();
  private readonly input: WorkspaceTrustDiscoveryInput;
  private readonly observer: DiscoveryObserver;
  private readonly match: ReturnType<typeof createClaudeWorkspaceTrustFrameMatcher> | undefined;

  constructor(input: WorkspaceTrustDiscoveryInput, observer: DiscoveryObserver) {
    this.input = input;
    this.observer = observer;
    this.match = input.evidence && createClaudeWorkspaceTrustFrameMatcher(input.evidence);
    this.writer = claudeTrustWriter(input, {
      current: () => {
        const answer = this.answerRequest;
        return answer &&
          answer.request === this.polling.currentRequest &&
          nativeRenderEvidenceIntact(input.terminal())
          ? answer
          : undefined;
      },
      read: () => this.reconcile(),
      verify: (candidate, signal) =>
        verifyClaudeTrustAnswer({
          candidate,
          signal,
          polling: this.polling,
          revision: observer.revision,
          canUseFrame: this.canUseTrustFrame,
          scopeLost: (frame, proved) => this.retireIfScopeProofLost(frame, proved),
          revoke: () => this.writer.answers.revoke("frame"),
        }),
      isFrameCurrent: this.canUseTrustFrame,
      reconcile: () => this.observeNativeFrame(),
      clear: () => this.retire("cleared"),
    });
  }

  answerDialog(requestId: string, choiceId: string, options?: ElwoodDialogAnswerOptions) {
    return this.writer.answers.answer(requestId, choiceId, options);
  }

  readonly recordConfirmation = () => this.writer.recordConfirmation();
  readonly nativeExit = (exit: PtyExit) => this.writer.nativeExit(exit);
  readonly invalidateEvidence = (): void => this.end("unavailable");

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    this.polling.bind(terminal, closing, () =>
      this.end("unavailable", closing.aborted ? "aborted" : "frame"),
    );
    this.writer.bindCallerInput(terminal);
  }

  endStartup(): void {
    let reason: Retirement = "unavailable";
    if (this.polling.currentRequest)
      runContained(() => {
        const frame = settledNativeSnapshot(this.input.terminal());
        if (frame && this.input.clearance(frame.text)) reason = "cleared";
      });
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

  observeNativeFrame(): ClaudeTrustAppearance | undefined {
    const candidate = this.reconcile();
    if (!this.polling.signal.aborted) this.writer.observePaint(candidate);
    return candidate;
  }

  /** Track settled menu changes between polls without consulting the filesystem. */
  reconcile(): ClaudeTrustAppearance | undefined {
    if (this.polling.signal.aborted || !this.match) return undefined;
    const terminal = this.input.terminal();
    const frame = settledNativeSnapshot(terminal);
    if (!frame) return undefined;
    if (this.input.clearance(frame.text)) {
      this.end("cleared");
      return undefined;
    }
    if (this.input.humanOwnedPrompt() !== "workspace_trust") {
      this.nativeAppearance.clear();
      this.retire("unavailable");
      return undefined;
    }
    const prior = this.polling.currentRequest;
    const current = this.polling.sample(terminal, frame, this.match);
    if (prior && !this.polling.currentRequest)
      this.observer.onRetire(prior, current ? "replaced" : "unavailable");
    return this.nativeAppearance.sample(frame, current);
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
    candidate: ClaudeTrustAppearance,
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

  private acceptProof(
    candidate: ClaudeTrustAppearance,
    proved: boolean | undefined,
  ): VerifiedWorkspaceTrust<"claude"> | undefined {
    this.retireIfScopeProofLost(candidate.frame, proved);
    if (proved !== true || !this.canUseTrustFrame(candidate.frame)) return undefined;
    const verified = this.polling.acceptVerified(this.input.elwoodSessionId, candidate);
    if (this.answerRequest?.request !== verified.request)
      this.answerRequest = openClaudeTrustAnswer(candidate.gateIdentity, verified.request);
    return verified;
  }

  private retireIfScopeProofLost(frame: TerminalSnapshot, proved: boolean | undefined): void {
    // A completed mismatch revokes the captured launch even after a repaint.
    if (proved === false || (proved === undefined && this.canUseTrustFrame(frame)))
      this.end("unavailable");
  }

  isRequestFrameCurrent({ frame, request }: VerifiedWorkspaceTrust<"claude">): boolean {
    return this.polling.currentRequest === request && this.canUseTrustFrame(frame);
  }

  private readonly canUseTrustFrame = (frame: TerminalSnapshot): boolean =>
    this.polling.canUseTrustFrame(frame, this.input);

  private end(reason: Retirement, category: "frame" | "aborted" = "frame"): void {
    this.writer.answers.revoke(category);
    this.writer.end();
    this.retire(reason);
    this.polling.end();
    this.nativeAppearance.clear();
    this.answerRequest = undefined;
  }

  private retire(reason: Retirement): void {
    const request = this.polling.currentRequest;
    this.polling.retire();
    if (request) this.observer.onRetire(request, reason);
  }
}
