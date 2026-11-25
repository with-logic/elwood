/** Track one unambiguous live API prompt at a time (PRD §5.4, C-API-70). */
import type { ApiPromptPresentation } from "../../core/activity/prompt-presentation.ts";
import { hasPromptText } from "../../core/activity/prompt-text.ts";
import type { SendOptions } from "../../core/images/types.ts";
import type { PasteDispatch, PasteGuard } from "../../core/input/paste-guard.ts";
import { readSendId } from "../../core/input/send-id.ts";
import {
  nativeRenderEvidenceIntact,
  onNativeRenderEvidenceInvalidated,
} from "../../terminal/cursor.ts";
import { observeInputWrite } from "../../terminal/forwarded-input.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { onCallerInput } from "./session-input.ts";

const maxCorrelatedPromptCodeUnits = 65_536;
const maxNativeTurnIds = 1_024;
const maxNativeTurnIdCodeUnits = 128;

export type PromptNormalizer = (payload: string, limit: number) => string | undefined;

type Submission = {
  readonly expectedHookPrompt: string | undefined;
  pasted: boolean;
  entered: boolean;
  api?: { readonly text: string; readonly sendId?: string };
};

export class PromptSubmissions {
  private draft: Submission | undefined;
  private readonly nativeTurnIds = new Set<string>();
  private readonly terminal: ElwoodTerminal;
  private readonly normalizePayload: PromptNormalizer;
  private track = true;

  constructor(terminal: ElwoodTerminal, closing: AbortSignal, normalizePayload: PromptNormalizer) {
    this.terminal = terminal;
    this.normalizePayload = normalizePayload;
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
      beforeCommand: () => {
        if (this.draft?.pasted) this.revoke();
      },
    };
  }

  private prepare(payload: string, empty: object | undefined): PasteDispatch | undefined {
    if (!this.track) return undefined;
    if (this.draft?.pasted) {
      this.revoke();
      return undefined;
    }
    const expectedHookPrompt =
      empty && payload.length <= maxCorrelatedPromptCodeUnits
        ? this.normalizePayload(payload, maxCorrelatedPromptCodeUnits)
        : undefined;
    const draft = { expectedHookPrompt, pasted: false, entered: false };
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

  /** Capture options at admission. Record the original text just before the first Enter. */
  captureCaller(
    text: string,
    options: SendOptions | undefined,
    beforeEnter: ((payload: string) => void) | undefined,
  ): (payload: string) => void {
    const sendId = readSendId(options);
    return (payload) => {
      const draft = this.draft;
      if (draft?.expectedHookPrompt !== undefined && text.length <= maxCorrelatedPromptCodeUnits)
        draft.api = { text, ...(sendId === undefined ? {} : { sendId }) };
      beforeEnter?.(payload);
    };
  }

  /** Cleanup can retire an unsubmitted draft only after native empty-composer proof. */
  cleared = (): void => {
    if (!this.draft?.entered) this.draft = undefined;
  };

  /** Attribute only after forwarding and before publishing the authenticated hook activity. */
  observeNativeSubmit(
    turnId: string,
    prompt: string | undefined,
    comparisonText?: string,
  ): ApiPromptPresentation | undefined {
    if (!this.track || this.nativeTurnIds.has(turnId)) return undefined;
    const validId = turnId.length > 0 && turnId.length <= maxNativeTurnIdCodeUnits;
    const hasHistoryRoom = this.nativeTurnIds.size < maxNativeTurnIds;
    // Losing the bounded identity history makes later matches ambiguous for this session.
    if (!(validId && hasHistoryRoom)) {
      this.revoke();
      return undefined;
    }
    this.nativeTurnIds.add(turnId);
    const draft = this.draft;
    if (!draft?.entered) return undefined;
    if (prompt === undefined || draft.expectedHookPrompt === undefined || !hasPromptText(prompt)) {
      this.revoke();
      return undefined;
    }
    const comparable =
      comparisonText === undefined
        ? prompt
        : this.normalizePayload(comparisonText, maxCorrelatedPromptCodeUnits);
    if (comparable !== draft.expectedHookPrompt) {
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
    this.nativeTurnIds.clear();
  };
}
