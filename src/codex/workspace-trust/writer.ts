/** Confirm verified Codex workspace trust choices through the live PTY (C-ATTN-07). */
import { WorkspaceTrustAnswers } from "../../core/dialogs/trust-answer/index.ts";
import type { ElwoodDialogAnswerOptions } from "../../core/dialogs/types.ts";
import { onCallerInput } from "../../runtime/session/session-input.ts";
import { onNativeRenderEvidenceInvalidated } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexTrustConfirmation } from "./answer-confirmation.ts";
import { codexWorkspaceTrustStep, type NumberedTrustOption } from "./answer-layout.ts";
import type { CodexWorkspaceTrustDiscovery } from "./discovery.ts";
import type { WorkspaceTrustDiscoveryInput } from "./discovery-input.ts";

type WriterInput = Pick<WorkspaceTrustDiscoveryInput, "terminal" | "clearance"> & {
  readonly manualTrust: boolean;
  readonly discovery: CodexWorkspaceTrustDiscovery;
  readonly deliveryRevision: () => number;
  readonly write: (keys: string) => Promise<void>;
};
export function codexTrustWriter({
  terminal,
  clearance,
  manualTrust,
  discovery,
  deliveryRevision,
  write,
}: WriterInput) {
  let relinquished = false;
  const answers: WorkspaceTrustAnswers<NumberedTrustOption, 0 | 1> = new WorkspaceTrustAnswers({
    currentRequest: () => {
      const current = discovery.currentRequestWithDeclineOutcome;
      if (!(manualTrust && current)) return undefined;
      const { request, declineOutcome } = current;
      const [accept, decline] = request.choices;
      if (request.choices.length !== 2 || !accept || !decline) return undefined;
      answers.revokeIfGateChanged(request.id);
      return {
        request,
        gateIdentity: request.id,
        choices: [
          { id: accept.id, choiceIndex: 0, outcome: "affirmative" },
          { id: decline.id, choiceIndex: 1, outcome: declineOutcome },
        ],
      };
    },
    readChoice: (_gate, index, requestId, previousFrame, finish, signal) => {
      // Wait for every synchronous dialog observer before collecting Git evidence.
      void Promise.resolve()
        .then(async () => {
          if (signal.aborted || relinquished) return undefined;
          const candidate = discovery.reconcileCandidate();
          if (!candidate || candidate.frame === previousFrame) return undefined;
          const { frame, menu } = candidate;
          const revision = deliveryRevision();
          const stillCurrent = () =>
            revision === deliveryRevision() &&
            !relinquished &&
            discovery.isRequestIdAtFrame(requestId, frame);
          const resume =
            previousFrame &&
            (() => {
              if (!signal.aborted) answers.resumeNavigation();
            });
          const result = await discovery.verifyRequestForAnswer(
            candidate,
            signal,
            stillCurrent,
            resume,
          );
          if (result === "expired" && !signal.aborted && stillCurrent()) answers.revoke("frame");
          if (result !== "verified") return undefined;
          return {
            frame,
            option: menu.dialog.options[index],
            claim: () => {
              if (!stillCurrent()) return false;
              confirmation.claim(candidate.identity);
              return true;
            },
          };
        })
        .then(finish)
        .catch(() => finish());
    },
    step: codexWorkspaceTrustStep,
    write,
    reconcileDialogEvidence: () => confirmation.recordConfirmation(),
    relinquish: () => {
      relinquished = true;
    },
  });
  const confirmation = codexTrustConfirmation({ terminal, clearance, discovery, answers });
  return {
    answerDialog: (requestId: string, choiceId: string, options?: ElwoodDialogAnswerOptions) =>
      answers.answer(requestId, choiceId, options),
    recordConfirmation: confirmation.recordConfirmation,
    retireNavigation: (id: string) => answers.retireNavigation(id),
    resumeAfterDialogDelivery: () => answers.resumeNavigation(),
    bind(current: ElwoodTerminal, closing: AbortSignal) {
      const offInput = onCallerInput(current, () => {
        relinquished = true;
        answers.revoke();
      });
      const offNative = onNativeRenderEvidenceInvalidated(current, () => answers.revoke());
      closing.addEventListener(
        "abort",
        () => {
          offInput();
          offNative();
          confirmation.closing();
        },
        { once: true },
      );
    },
    observeFrame: confirmation.observeFrame,
    nativeExit: confirmation.nativeExit,
  };
}
