/** Bind Claude workspace trust answers to fresh Git proof and native frame ownership (C-ATTN-07). */
import { type ReadChoice, WorkspaceTrustAnswers } from "../../core/dialogs/trust-answer/index.ts";
import type { ElwoodDialogRequest } from "../../core/dialogs/types.ts";
import type { SelectableOption } from "../../core/terminal-options.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { trustStep } from "../../core/trust/step.ts";
import { trustView } from "../../core/trust/view.ts";
import type { PtyExit } from "../../pty/types.ts";
import { onCallerInput, withAutomatedInput } from "../../runtime/session/session-input.ts";
import { nativeRenderEvidenceIntact, settledNativeSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import { claudeAnswerOwnership } from "./answer-ownership.ts";
import {
  claudeTrustExitLabel,
  claudeTrustFooter,
  readWorkspaceTrustPrelude,
  type WorkspaceTrustFrame,
} from "./menu.ts";
import type { ClaudeLaunchTrustEvidence } from "./target.ts";

const workspaceInputGraceMs = 1_500;

export type ClaudeTrustAppearance = WorkspaceTrustFrame & { readonly gateIdentity: string };

type Evidence = {
  readonly read: () => ClaudeTrustAppearance | undefined;
  readonly verify: (
    observation: WorkspaceTrustFrame,
    signal: AbortSignal,
  ) => Promise<(() => boolean) | undefined>;
  readonly canWrite: (gateIdentity: string) => boolean;
  readonly claim: (frame: TerminalSnapshot, requestId: string, identity: string) => boolean;
};

function readClaudeTrustChoice(evidence: Evidence): ReadChoice<SelectableOption, 0 | 1> {
  return (gate, index, requestId, previousFrame, finish, signal) => {
    if (!evidence.canWrite(gate)) return finish();
    const current = evidence.read();
    if (!current || current.frame === previousFrame || current.gateIdentity !== gate)
      return finish();
    const { frame, menu } = current;
    const option = menu.dialog.options[index];
    void evidence.verify(current, signal).then((verified) => {
      if (!verified) return finish();
      finish({ frame, option, claim: () => verified() && evidence.claim(frame, requestId, gate) });
    });
  };
}

function completeBypassPrompt(frame: TerminalSnapshot): boolean {
  const view = trustView(frame.text, "claude", () => false);
  if (view.kind !== "candidate" || !view.valid || view.spec.id !== "bypass_permissions")
    return false;
  const labels = view.dialog.options.map(({ label }) => label);
  const footer = frame.lines.findLast((line) => line.trim().length > 0)?.trim();
  return (
    labels.length === 2 &&
    labels.includes(claudeTrustExitLabel) &&
    labels.includes("Yes, I accept") &&
    (footer === claudeTrustFooter || footer === "Enter to confirm")
  );
}

type WriterIo = Omit<Evidence, "claim" | "canWrite"> & {
  readonly current: () => ReturnType<typeof openClaudeTrustAnswer> | undefined;
  readonly isFrameCurrent: (frame: TerminalSnapshot) => boolean;
  readonly reconcile: () => void;
  readonly clear: () => void;
};

export function claudeTrustWriter(
  {
    terminal,
    clearance,
    manualTrust,
    evidence,
  }: {
    readonly terminal: () => ElwoodTerminal;
    readonly clearance: TrustClearance;
    readonly manualTrust: boolean;
    readonly evidence: ClaudeLaunchTrustEvidence | undefined;
  },
  io: WriterIo,
) {
  const ownership = claudeAnswerOwnership();
  let stopCallerInput: (() => void) | undefined;
  const recordConfirmation = () => {
    if (!answers.confirmationDispatched) return;
    const frame = settledNativeSnapshot(terminal());
    if (
      frame &&
      (clearance(frame.text) || completeBypassPrompt(frame)) &&
      answers.recordConfirmation("affirmative")
    )
      io.clear();
  };
  const answers = new WorkspaceTrustAnswers({
    currentRequest: () => (manualTrust ? io.current() : undefined),
    readChoice: readClaudeTrustChoice({
      ...io,
      canWrite: ownership.canWrite,
      claim: (frame, requestId, identity) =>
        io.isFrameCurrent(frame) &&
        io.current()?.request.id === requestId &&
        ownership.canWrite(identity),
    }),
    step: trustStep,
    write: (keys) => {
      const current = terminal();
      return withAutomatedInput(current, () => current.sendInput(keys));
    },
    reconcileDialogEvidence: () => {
      recordConfirmation();
      io.reconcile();
    },
    relinquish: ownership.relinquish,
  });
  return {
    answers,
    recordConfirmation,
    nativeExit({ exitCode, signal }: PtyExit) {
      // Claude's native decline exits 1 without a terminating signal.
      if (nativeRenderEvidenceIntact(terminal())) answers.nativeExit(exitCode === 1 && !signal);
    },
    observePaint(gate: ClaudeTrustAppearance | undefined) {
      if (!(manualTrust && evidence)) return;
      if (gate) {
        answers.revokeIfGateChanged(gate.gateIdentity);
        ownership.observeGate(gate, gate.menu.promptHeaderKey);
        answers.resumeNavigation();
      } else {
        const current = terminal();
        const frame = settledNativeSnapshot(current);
        if (!frame) return;
        ownership.observePrelude(readWorkspaceTrustPrelude(evidence.scope, current, frame));
        if (!answers.confirmationDispatched) answers.revoke("frame");
      }
    },
    end() {
      stopCallerInput?.();
    },
    bindCallerInput(current: ElwoodTerminal) {
      if (!(manualTrust && evidence)) return;
      stopCallerInput = onCallerInput(current, () => {
        answers.revoke();
        const frame = settledNativeSnapshot(current);
        if (frame) {
          const gate = io.read();
          if (gate) ownership.observeGate(gate, gate.menu.promptHeaderKey);
          else ownership.observePrelude(readWorkspaceTrustPrelude(evidence.scope, current, frame));
        }
        ownership.callerInput();
      });
    },
  };
}

export function openClaudeTrustAnswer(
  gateIdentity: string,
  request: ElwoodDialogRequest<"claude">,
) {
  return {
    request,
    gateIdentity,
    choices: request.choices.map(
      ({ id, label }, index) =>
        ({
          id,
          choiceIndex: index === 0 ? 0 : 1,
          outcome: label === claudeTrustExitLabel ? "exit" : "affirmative",
        }) as const,
    ),
    earliestInputAtMs: performance.now() + workspaceInputGraceMs,
  };
}
