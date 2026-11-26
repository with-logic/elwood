/**
 * Track one unambiguous live API prompt at a time (PRD §5.4, C-API-70, C-API-71). Its hook
 * starts a new native turn, except guidance, whose hook reuses the running turn's ID.
 */
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
import type { SubmitKind } from "./image-attach.ts";
import { onCallerInput } from "./session-input.ts";

const maxCorrelatedPromptCodeUnits = 65_536;
const maxNativeTurnIds = 1_024;
const maxNativeTurnIdCodeUnits = 128;

export type PromptNormalizer = (
  payload: string,
  maxNormalizedCodeUnits: number,
) => string | undefined;

type Submission = {
  readonly expectedNormalizedPrompt: string | undefined;
  pasted: boolean;
  entered: boolean;
  api?: { readonly text: string; readonly sendId?: string };
  /** Claude and Codex fire guidance's hook under the running turn's existing native ID. */
  guidance?: boolean;
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
      // Claude's working composer is empty to every send; only guidance can claim a reused ID.
      observePaste: (payload, empty) =>
        this.prepare(
          payload,
          nativeRenderEvidenceIntact(this.terminal)
            ? (empty ?? guard.workingEmptyFrame?.())
            : undefined,
        ),
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
    const expectedNormalizedPrompt =
      empty && payload.length <= maxCorrelatedPromptCodeUnits
        ? this.normalizePayload(payload, maxCorrelatedPromptCodeUnits)
        : undefined;
    const draft = { expectedNormalizedPrompt, pasted: false, entered: false };
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
    kind: SubmitKind,
  ): (payload: string) => void {
    const sendId = readSendId(options);
    return (payload) => {
      const draft = this.draft;
      if (
        draft?.expectedNormalizedPrompt !== undefined &&
        text.length <= maxCorrelatedPromptCodeUnits
      ) {
        draft.api = { text, ...(sendId === undefined ? {} : { sendId }) };
        draft.guidance = kind === "guidance";
      }
      beforeEnter?.(payload);
    };
  }

  /** Cleanup can retire an unsubmitted draft only after native empty-composer proof. */
  cleared = (): void => {
    if (!this.draft?.entered) this.draft = undefined;
  };

  /** Associate before publishing the hook activity. Claude supplies displayed text to normalize.
   * Codex supplies its canonical hook prompt directly. */
  observeNativeSubmit({
    turnId,
    nativePrompt,
    displayedNativeText,
  }: {
    readonly turnId: string;
    readonly nativePrompt: string | undefined;
    readonly displayedNativeText?: string | undefined;
  }): ApiPromptPresentation | undefined {
    if (!this.track) return undefined;
    // An existing ID can name only pending guidance, never another submission.
    if (this.nativeTurnIds.has(turnId))
      return this.draft?.guidance
        ? this.claim(turnId, nativePrompt, displayedNativeText)
        : undefined;
    const validId = turnId.length > 0 && turnId.length <= maxNativeTurnIdCodeUnits;
    const hasHistoryRoom = this.nativeTurnIds.size < maxNativeTurnIds;
    // Losing the bounded identity history makes later matches ambiguous for this session.
    if (!(validId && hasHistoryRoom)) {
      this.revoke();
      return undefined;
    }
    this.nativeTurnIds.add(turnId);
    return this.claim(turnId, nativePrompt, displayedNativeText);
  }

  /** The pending submission's hook: an exact match claims it once, and a mismatch ends tracking. */
  private claim(
    turnId: string,
    nativePrompt: string | undefined,
    displayedNativeText: string | undefined,
  ): ApiPromptPresentation | undefined {
    const draft = this.draft;
    if (!draft?.entered) return undefined;
    if (
      nativePrompt === undefined ||
      draft.expectedNormalizedPrompt === undefined ||
      !hasPromptText(nativePrompt)
    ) {
      this.revoke();
      return undefined;
    }
    const comparable =
      displayedNativeText === undefined
        ? nativePrompt
        : this.normalizePayload(displayedNativeText, maxCorrelatedPromptCodeUnits);
    if (comparable !== draft.expectedNormalizedPrompt) {
      this.revoke();
      return undefined;
    }
    this.draft = undefined;
    if (!draft.api) return undefined;
    return {
      ...draft.api,
      nativePrompt,
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
