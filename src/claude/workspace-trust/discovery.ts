/** List Claude's human-owned workspace trust menu with settled native and Git evidence (C-ATTN-07). */
import type { ElwoodDialogRequest } from "../../core/dialogs/types.ts";
import {
  type VerifiedWorkspaceTrust,
  WorkspaceTrustPolling,
} from "../../core/dialogs/workspace-trust-polling.ts";
import { createWorkspaceTrustRequest } from "../../core/dialogs/workspace-trust-request.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { TrustPromptIdFor } from "../../core/trust/prompts.ts";
import { settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { createClaudeWorkspaceTrustFrameMatcher, type WorkspaceTrustFrame } from "./menu.ts";
import type { ClaudeLaunchTrustEvidence } from "./target.ts";

type DialogRequest = ElwoodDialogRequest<"claude">;
type Open = { readonly identity: string; readonly request: DialogRequest };
type DiscoveryInput = {
  readonly elwoodSessionId: string;
  readonly evidence: ClaudeLaunchTrustEvidence | undefined;
  readonly terminal: () => ElwoodTerminal;
  readonly humanOwnedPrompt: () => TrustPromptIdFor<"claude"> | undefined;
  readonly clearance: TrustClearance;
};

export class ClaudeWorkspaceTrustDiscovery {
  private open: Open | undefined;
  private sampled:
    | { readonly frame: TerminalSnapshot; readonly candidate: WorkspaceTrustFrame | undefined }
    | undefined;
  private readonly polling = new WorkspaceTrustPolling<"claude">();
  private readonly input: DiscoveryInput;
  private readonly match: ReturnType<typeof createClaudeWorkspaceTrustFrameMatcher> | undefined;

  constructor(input: DiscoveryInput) {
    this.input = input;
    this.match = input.evidence && createClaudeWorkspaceTrustFrameMatcher(input.evidence);
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    this.polling.bind(terminal, closing, () => this.endDiscovery());
  }

  endDiscovery(): void {
    this.polling.end();
    this.sampled = undefined;
    this.open = undefined;
  }

  async list(): Promise<readonly DialogRequest[]> {
    const verified = await this.read();
    return verified && this.isCurrent(verified) ? [verified.request] : [];
  }

  /** Track settled menu changes between polls without consulting the filesystem. */
  reconcile(): WorkspaceTrustFrame | undefined {
    if (this.polling.signal.aborted || !this.match) return undefined;
    const terminal = this.input.terminal();
    const frame = settledNativeSnapshot(terminal);
    if (!frame) return undefined;
    if (this.input.clearance(frame.text)) {
      this.endDiscovery();
      return undefined;
    }
    if (this.input.humanOwnedPrompt() !== "workspace_trust") {
      this.open = undefined;
      return undefined;
    }
    if (this.sampled?.frame !== frame)
      this.sampled = { frame, candidate: this.match(terminal, frame) };
    const { candidate } = this.sampled;
    if (!candidate || (this.open && this.open.identity !== candidate.identity))
      this.open = undefined;
    return candidate;
  }

  private async read(): Promise<VerifiedWorkspaceTrust<"claude"> | undefined> {
    const candidate = this.reconcile();
    if (!candidate) return undefined;
    return await this.polling.read(candidate.frame, candidate.revalidateLaunchEvidence, (proved) =>
      this.acceptProof(candidate, proved),
    );
  }

  private acceptProof(
    { frame, menu, identity }: WorkspaceTrustFrame,
    proved: boolean | undefined,
  ): VerifiedWorkspaceTrust<"claude"> | undefined {
    // A completed Claude mismatch revokes the captured launch even after a repaint.
    if (proved === false) {
      this.endDiscovery();
      return undefined;
    }
    if (!this.isFrameCurrent(frame)) return undefined;
    if (proved === undefined) {
      this.endDiscovery();
      return undefined;
    }

    if (this.open?.identity !== identity) {
      this.open = {
        identity,
        request: createWorkspaceTrustRequest("claude", this.input.elwoodSessionId, menu),
      };
    }
    return { frame, request: this.open.request };
  }

  private isCurrent({ frame, request }: VerifiedWorkspaceTrust<"claude">): boolean {
    return this.open?.request === request && this.isFrameCurrent(frame);
  }

  private isFrameCurrent(frame: TerminalSnapshot): boolean {
    return this.polling.isFrameCurrent(frame, this.input);
  }
}
