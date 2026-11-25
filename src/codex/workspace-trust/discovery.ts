/** List the current workspace trust menu using native output and verified launch evidence (C-ATTN-07). */
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import { settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { createTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu-frame.ts";
import type { ElwoodDialogRequest } from "./types.ts";

export class CodexWorkspaceTrustDiscovery {
  private readonly polling = new WorkspaceTrustPolling<"codex", WorkspaceTrustFrame>();
  private readonly input: WorkspaceTrustDiscoveryInput;
  private readonly match: ReturnType<typeof createTrustFrameMatcher> | undefined;

  constructor(input: WorkspaceTrustDiscoveryInput) {
    this.input = input;
    this.match = input.evidence && createTrustFrameMatcher(input.evidence);
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    this.polling.bind(terminal, closing, () => this.end());
  }

  /** Track native layout changes without reading the filesystem. */
  reconcileAfter(update: () => void): void {
    try {
      update();
    } finally {
      this.reconcile();
    }
  }

  endStartup(): void {
    this.end();
  }

  /** Identity persists through an unsettled repaint. Only read() verifies a request. */
  get currentRequestId(): string | undefined {
    return this.polling.currentRequest?.id;
  }

  async list(): Promise<readonly ElwoodDialogRequest[]> {
    const verified = await this.read();
    return verified && this.isRequestFrameCurrent(verified) ? [verified.request] : [];
  }

  async read(): Promise<VerifiedWorkspaceTrust<"codex"> | undefined> {
    const candidate = this.reconcile();
    if (!candidate) return undefined;
    return await this.polling.read(candidate.frame, candidate.revalidateLaunchEvidence, (proved) =>
      this.acceptProof(candidate, proved),
    );
  }

  isRequestFrameCurrent({ frame, request }: VerifiedWorkspaceTrust<"codex">): boolean {
    return this.currentRequestId === request.id && this.canUseTrustFrame(frame);
  }

  private reconcile(): WorkspaceTrustFrame | undefined {
    if (this.polling.signal.aborted || !this.match) return undefined;
    const terminal = this.input.terminal();
    const frame = settledNativeSnapshot(terminal);
    if (!frame) return undefined;
    if (this.input.clearance(frame.text)) {
      this.end();
      return undefined;
    }
    if (this.input.humanOwnedPrompt() !== "workspace_trust") {
      this.retire();
      return undefined;
    }
    return this.polling.sample(terminal, frame, this.match);
  }

  private acceptProof(
    candidate: WorkspaceTrustFrame,
    proved: boolean | undefined,
  ): VerifiedWorkspaceTrust<"codex"> | undefined {
    if (!this.canUseTrustFrame(candidate.frame)) return undefined;
    // Expiry ends discovery. A completed mismatch only retires this request.
    if (proved === undefined) {
      this.end();
      return undefined;
    }
    if (proved === false) {
      this.retire();
      return undefined;
    }

    return this.polling.acceptVerified("codex", this.input.elwoodSessionId, candidate);
  }

  private canUseTrustFrame(frame: TerminalSnapshot): boolean {
    return this.polling.canUseTrustFrame(frame, this.input);
  }

  private end(): void {
    this.polling.end();
  }

  private retire(): void {
    this.polling.retire();
  }
}
