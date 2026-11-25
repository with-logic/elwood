/** List the current workspace trust menu using native output and verified launch evidence (C-ATTN-07). */
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import { createWorkspaceTrustRequest } from "../../core/dialogs/workspace-trust-request.ts";
import { settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { createTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu-frame.ts";
import type { ElwoodDialogRequest } from "./types.ts";

type Open = { readonly identity: string; readonly request: ElwoodDialogRequest };

export class CodexWorkspaceTrustDiscovery {
  private open: Open | undefined;
  private sampled:
    | { readonly frame: TerminalSnapshot; readonly candidate: WorkspaceTrustFrame | undefined }
    | undefined;
  private readonly polling = new WorkspaceTrustPolling<"codex">();
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
    return this.open?.request.id;
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
    if (this.sampled?.frame !== frame)
      this.sampled = { frame, candidate: this.match(terminal, frame) };
    const { candidate } = this.sampled;
    if (!candidate || (this.open && this.open.identity !== candidate.identity)) this.retire();
    return candidate;
  }

  private acceptProof(
    { frame, menu, identity }: WorkspaceTrustFrame,
    proved: boolean | undefined,
  ): VerifiedWorkspaceTrust<"codex"> | undefined {
    if (!this.canUseTrustFrame(frame)) return undefined;
    // Expiry ends discovery. A completed mismatch only retires this request.
    if (proved === undefined) {
      this.end();
      return undefined;
    }
    if (proved === false) {
      this.retire();
      return undefined;
    }

    if (this.open?.identity !== identity) {
      this.open = {
        identity,
        request: createWorkspaceTrustRequest("codex", this.input.elwoodSessionId, menu),
      };
    }
    return { frame, request: this.open.request };
  }

  private canUseTrustFrame(frame: TerminalSnapshot): boolean {
    return this.polling.isFrameCurrent(frame, this.input);
  }

  private end(): void {
    this.polling.end();
    this.sampled = undefined;
    this.retire();
  }

  private retire(): void {
    this.open = undefined;
  }
}
