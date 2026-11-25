/** Track one unambiguous live Codex API prompt at a time (PRD §5.4, C-API-70). */
import type { ApiPromptPresentation } from "../../core/activity/prompt-presentation.ts";
import { hasPromptText } from "../../core/activity/prompt-text.ts";
import { runContained } from "../../core/contained.ts";
import type { SendOptions } from "../../core/images/types.ts";
import type { PasteDispatch, PasteGuard } from "../../core/input/paste-guard.ts";
import {
  nativeRenderEvidenceIntact,
  onNativeRenderEvidenceInvalidated,
} from "../../terminal/cursor.ts";
import { observeInputWrite } from "../../terminal/forwarded-input.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { onCallerInput } from "./session-input.ts";

const maxPromptLength = 65_536;
const maxNativeIds = 1_024;

type Submission = {
  readonly comparable: string | undefined;
  pasted: boolean;
  entered: boolean;
  api?: { readonly text: string; readonly sendId?: string };
};

export class PromptSubmissions {
  private draft: Submission | undefined;
  private readonly nativeIds = new Set<string>();
  private readonly terminal: ElwoodTerminal;
  private track = true;

  constructor(terminal: ElwoodTerminal, closing: AbortSignal) {
    this.terminal = terminal;
    const stopInput = onCallerInput(terminal, this.revoke);
    const stopRender = onNativeRenderEvidenceInvalidated(terminal, this.revoke);
    closing.addEventListener(
      "abort",
      () => {
        stopInput();
        stopRender();
        this.revoke();
      },
      { once: true },
    );
  }

  guard(guard: PasteGuard): PasteGuard {
    return {
      ...guard,
      observePaste: (payload, empty) =>
        this.prepare(payload, nativeRenderEvidenceIntact(this.terminal) ? empty : undefined),
      beforeCommand: this.revoke,
    };
  }

  private prepare(payload: string, empty: object | undefined): PasteDispatch | undefined {
    if (!this.track) return undefined;
    if (this.draft?.pasted) {
      this.revoke();
      return undefined;
    }
    const comparable =
      empty && payload.length <= maxPromptLength
        ? payload.replace(/\r\n?/g, "\n").trim()
        : undefined;
    const draft = { comparable, pasted: false, entered: false };
    this.draft = draft;
    return (data, dispatch) =>
      observeInputWrite(
        this.terminal.xterm,
        (actual) => {
          if (actual !== data || this.draft !== draft) return undefined;
          if (data === "\r")
            return () => {
              draft.entered = draft.pasted;
            };
          return () => {
            draft.pasted = true;
          };
        },
        dispatch,
      );
  }

  captureCaller(
    text: string,
    options: SendOptions | undefined,
    beforeEnter: ((payload: string) => void) | undefined,
  ): (payload: string) => void {
    let id: unknown;
    runContained(() => {
      id = options?.sendId;
    });
    const sendId = typeof id === "string" && id.length <= 1_024 ? id : undefined;
    return (payload) => {
      const draft = this.draft;
      if (draft?.comparable !== undefined && text.length <= maxPromptLength)
        draft.api = { text, ...(sendId === undefined ? {} : { sendId }) };
      beforeEnter?.(payload);
    };
  }

  /** Cleanup can retire an unsubmitted draft only after native empty-composer proof. */
  cleared = (): void => {
    if (!this.draft?.entered) this.draft = undefined;
  };

  observeNativeSubmit(
    turnId: string,
    prompt: string | undefined,
  ): ApiPromptPresentation | undefined {
    if (!this.track || this.nativeIds.has(turnId)) return undefined;
    if (!turnId || turnId.length > 128 || this.nativeIds.size === maxNativeIds) {
      this.revoke();
      return undefined;
    }
    this.nativeIds.add(turnId);
    const draft = this.draft;
    if (!draft?.entered) return undefined;
    if (prompt === undefined || prompt !== draft.comparable || !hasPromptText(prompt)) {
      this.revoke();
      return undefined;
    }
    this.draft = undefined;
    if (!draft.api) return undefined;
    return {
      ...draft.api,
      nativePrompt: prompt,
      promptProvenance: { origin: "api", input: "pasted" },
      turnId,
    };
  }

  revoke = (): void => {
    this.track = false;
    this.draft = undefined;
    this.nativeIds.clear();
  };
}
