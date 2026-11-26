/**
 * A Codex session's native dialogs: its workspace trust question and its update offer share
 * `listDialogs` and `dialog` events. `answerDialog` answers trust only; an update request ID
 * rejects with `dialog_not_found`, since hosts answer the offer at the terminal (PRD §5.13,
 * C-ATTN-07, C-ATTN-08, C-ATTN-12).
 */
import type {
  ElwoodDialogAnswerOptions,
  ElwoodDialogEvent,
  ElwoodDialogRequest,
} from "../../core/dialogs/types.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { CodexUpdateDialogs } from "../update/dialogs.ts";
import { CodexWorkspaceTrustDialogs } from "../workspace-trust/dialogs.ts";

type DialogListener = (event: ElwoodDialogEvent) => unknown;
type CodexSessionDialogsInput = ConstructorParameters<typeof CodexWorkspaceTrustDialogs>[0] & {
  /** The session's frame failure report, which update discovery uses (C-API-72). */
  readonly reportFailure: () => void;
};

export class CodexSessionDialogs {
  readonly trust: CodexWorkspaceTrustDialogs;
  readonly update: CodexUpdateDialogs;

  constructor(input: CodexSessionDialogsInput) {
    this.trust = new CodexWorkspaceTrustDialogs(input);
    const { observeNotifications } = this.trust;
    this.update = new CodexUpdateDialogs({ ...input, observeNotifications });
  }

  async list(): Promise<readonly ElwoodDialogRequest[]> {
    const trust = await this.trust.discovery.list();
    return [...trust, ...this.update.list()];
  }

  answerDialog(requestId: string, choiceId: string, options?: ElwoodDialogAnswerOptions) {
    return this.trust.answerDialog(requestId, choiceId, options);
  }

  /** The first readiness ends the startup window for both dialogs. */
  endStartup(): void {
    this.trust.discovery.endStartup();
    this.update.endDiscovery();
  }

  bind(terminal: ElwoodTerminal, closing: AbortSignal): void {
    this.trust.bind(terminal, closing);
    this.update.bind(terminal, closing);
  }

  listenerAdded(handler: DialogListener): void {
    this.trust.listenerAdded(handler);
    this.update.listenerAdded(handler);
  }

  listenerRemoved(handler: DialogListener): void {
    this.trust.listenerRemoved(handler);
    this.update.listenerRemoved(handler);
  }
}
