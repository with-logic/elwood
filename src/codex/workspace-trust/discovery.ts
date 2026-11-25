/** List the current workspace trust menu using native output and verified launch evidence (C-ATTN-07). */
import { randomUUID } from "node:crypto";
import { boundedTrustEvidence } from "../../core/trust/evidence-deadline.ts";
import { onNativeRenderEvidenceInvalidated, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";
import { createTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu-frame.ts";
import type { ElwoodDialogRequest } from "./types.ts";

type VerifiedWorkspaceTrust = {
  readonly frame: TerminalSnapshot;
  readonly request: ElwoodDialogRequest;
};
type Open = { readonly identity: string; readonly request: ElwoodDialogRequest };
type Verification = {
  readonly frame: TerminalSnapshot;
  readonly result: Promise<VerifiedWorkspaceTrust | undefined>;
};

export class CodexWorkspaceTrustDiscovery {
  private open: Open | undefined;
  private sampled:
    | { readonly frame: TerminalSnapshot; readonly candidate: WorkspaceTrustFrame | undefined }
    | undefined;
  private checking: Verification | undefined;
  private readonly lifetime = new AbortController();
  private readonly input: WorkspaceTrustDiscoveryInput;
  private readonly match: ReturnType<typeof createTrustFrameMatcher> | undefined;

  constructor(input: WorkspaceTrustDiscoveryInput) {
    this.input = input;
    this.match = input.evidence && createTrustFrameMatcher(input.evidence);
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    const offNative = onNativeRenderEvidenceInvalidated(terminal, () => this.end());
    closing.addEventListener(
      "abort",
      () => {
        offNative();
        this.end();
      },
      { once: true },
    );
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

  async read(): Promise<VerifiedWorkspaceTrust | undefined> {
    const candidate = this.reconcile();
    if (!candidate) return undefined;

    if (this.checking) {
      // Never queue the current frame behind an obsolete lookup and a second deadline.
      return this.checking.frame === candidate.frame ? await this.checking.result : undefined;
    }
    const result = this.verify(candidate).finally(() => {
      this.checking = undefined;
    });
    this.checking = { frame: candidate.frame, result };
    return await result;
  }

  isRequestFrameCurrent({ frame, request }: VerifiedWorkspaceTrust): boolean {
    return this.currentRequestId === request.id && this.canUseTrustFrame(frame);
  }

  private reconcile(): WorkspaceTrustFrame | undefined {
    if (this.lifetime.signal.aborted || !this.match) return undefined;
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

  private async verify(
    candidate: WorkspaceTrustFrame,
  ): Promise<VerifiedWorkspaceTrust | undefined> {
    const { frame, menu, identity, revalidateLaunchEvidence } = candidate;
    const proved = await boundedTrustEvidence(revalidateLaunchEvidence, this.lifetime.signal);
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
      const request: ElwoodDialogRequest = Object.freeze({
        id: randomUUID(),
        elwoodSessionId: this.input.elwoodSessionId,
        agent: "codex",
        kind: "trust",
        label: "workspace_trust",
        ...menu.target,
        text: menu.dialog.header,
        choices: Object.freeze(
          menu.dialog.options.map(({ label }) => Object.freeze({ id: randomUUID(), label })),
        ),
      });
      this.open = { identity, request };
    }
    return { frame, request: this.open.request };
  }

  private canUseTrustFrame(frame: TerminalSnapshot): boolean {
    return (
      !this.lifetime.signal.aborted &&
      this.input.humanOwnedPrompt() === "workspace_trust" &&
      settledNativeSnapshot(this.input.terminal()) === frame
    );
  }

  private end(): void {
    this.lifetime.abort();
    this.sampled = undefined;
    this.retire();
  }

  private retire(): void {
    this.open = undefined;
  }
}
