/** Public native Codex queued and modal question round trips (PRD §5.10, §7A). */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import type { CodexSession, ElwoodActivityEvent, ElwoodQuestionEvent } from "../../src/index.ts";
import {
  modalLiteralAnswer,
  publicCodexLongAnswer,
  queuedLiteralAnswer,
} from "./questions/codex-public-answers.ts";
import { publicCodexModalPhase, publicCodexQueuedPhase } from "./questions/codex-public-phases.ts";
import {
  captureCodexQuestionCursor,
  publicCodexQuestionRecords,
  publicCodexQuestionSandbox,
  publicCodexQuestionSession,
} from "./questions/codex-public-sandbox.ts";
import { codexQuestionProofSkip, questionCodexVersion } from "./questions/codex-sandbox.ts";
import { assertQuestionAnswerPrivacy, privateQuestionArtifacts } from "./questions/proof-files.ts";

test("C-E2E-19 native Codex queued and grouped answers preserve the caller turn", {
  skip: codexQuestionProofSkip("two isolated valid-model turns"),
  timeout: 240_000,
}, async (t) => {
  const sandbox = await publicCodexQuestionSandbox();
  let facade: CodexSession | undefined;
  let artifacts: ReturnType<typeof privateQuestionArtifacts> | undefined;
  const cursorCapture: {
    current: ReturnType<typeof captureCodexQuestionCursor> | undefined;
  } = { current: undefined };
  let primaryFailure = false;
  let primaryError: unknown;
  const events: ElwoodQuestionEvent[] = [];
  const normalized: Extract<ElwoodActivityEvent, { kind: "question" }>[] = [];
  const messages: string[] = [];
  const privateAnswers: string[] = [];
  const diagnostic = (error: unknown) =>
    t.diagnostic(error instanceof Error ? error.message : "Secondary native proof failure");
  const secondary = async (work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (primaryFailure) diagnostic(error);
      else {
        primaryFailure = true;
        primaryError = error;
      }
    }
  };
  const abort = () => {
    void facade?.close().catch(diagnostic);
  };
  try {
    t.signal.addEventListener("abort", abort, { once: true });
    t.signal.throwIfAborted();
    artifacts = privateQuestionArtifacts(sandbox.root);
    const marker = randomUUID();
    const note = publicCodexLongAnswer(`ELWOOD_API_NOTE_${marker}`);
    const modalNote = publicCodexLongAnswer(`ELWOOD_API_MODAL_${marker}`);
    privateAnswers.push(
      marker,
      note.accepted,
      modalNote.accepted,
      queuedLiteralAnswer,
      modalLiteralAnswer,
    );
    const create = () => {
      t.signal.throwIfAborted();
      const session = publicCodexQuestionSession(sandbox);
      session.on("question", (event) => events.push(event));
      session.on("activity", (event) => {
        if (event.kind === "assistant_message" && event.text) messages.push(event.text);
        if (event.kind === "question") normalized.push(event);
      });
      return session;
    };
    facade = create();
    const answeredRequestIds = [
      ...(await publicCodexQueuedPhase({
        facade,
        sandbox,
        events,
        messages,
        signal: t.signal,
        note,
        capture(terminal) {
          cursorCapture.current = captureCodexQuestionCursor(terminal, sandbox.root);
        },
      })),
    ];
    cursorCapture.current?.assertNoCaptureError();
    cursorCapture.current?.dispose();
    cursorCapture.current = undefined;
    await facade.close();
    t.signal.throwIfAborted();
    facade = create();
    answeredRequestIds.push(
      await publicCodexModalPhase({ facade, sandbox, events, signal: t.signal, note: modalNote }),
    );
    assert.deepEqual(
      events.flatMap((event) =>
        event.phase === "closed" ? [[event.request.id, event.reason]] : [],
      ),
      answeredRequestIds.map((requestId) => [requestId, "answered"]),
    );
    assert.deepEqual(
      normalized.map((event) => event.question),
      events,
    );
    assertQuestionAnswerPrivacy(sandbox.stateDir, [...events, ...normalized], privateAnswers);
    t.diagnostic(
      `${questionCodexVersion}: three independent queued answers and one three-question Plan set matched complete native records; send completed only on final.`,
    );
  } catch (error) {
    primaryFailure = true;
    primaryError = error;
    try {
      if (facade?.session)
        artifacts?.write(
          "failure",
          JSON.stringify({
            snapshot: facade.session.terminal.snapshot(),
            writes: sandbox.writes,
            status: facade.status,
            title: facade.session.terminal.title,
            events,
            records: publicCodexQuestionRecords(sandbox.home),
          }),
        );
    } catch (captureError) {
      diagnostic(captureError);
    }
  } finally {
    t.signal.removeEventListener("abort", abort);
    await secondary(() => facade?.close());
    await secondary(() => cursorCapture.current?.assertNoCaptureError());
    await secondary(() => cursorCapture.current?.dispose());
    await secondary(() =>
      assertQuestionAnswerPrivacy(sandbox.stateDir, [...events, ...normalized], privateAnswers),
    );
    await secondary(() => sandbox.dispose());
    await secondary(() => assert.equal(existsSync(sandbox.root), false));
  }
  if (primaryFailure) throw primaryError;
});
