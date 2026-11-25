/** Native Claude grouped, multiline and checkbox answers, unnamed and named (PRD §5.10). */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  ClaudeSession,
  type ElwoodActivityEvent,
  type ElwoodQuestionEvent,
} from "../../src/index.ts";
import { defaultClaudeTempDir } from "./claude-home.ts";
import { claudeTempFolder, claudeTempFoldersNamed } from "./claude-temp.ts";
import { claudeQuestionArtifacts } from "./questions/claude-artifacts.ts";
import {
  claudeProofTexts,
  claudeProofTimeoutMs,
  claudeQuestionLabel,
  claudeQuestionSessionName,
  claudeReadyTimeoutMs,
} from "./questions/claude-cases.ts";
import { type ClaudeProofLifecycle, claudeProofQueue } from "./questions/claude-lifecycle.ts";
import { type ClaudeNoticeProof, claudeNoticeProof } from "./questions/claude-notice.ts";
import { claudeQuestionRounds } from "./questions/claude-round.ts";
import { type ClaudeRoundKind, claudeRoundsByKind } from "./questions/claude-round-kinds.ts";
import { claudeQuestionBinary, nativeClaudeQuestionSandbox } from "./questions/claude-sandbox.ts";
import { assertQuestionAnswerPrivacy } from "./questions/proof-files.ts";

/** One isolated session: its rounds in order, whether they keep blank cells, and its `--name`. */
type ProofSession = {
  readonly rounds: readonly ClaudeRoundKind[];
  readonly blankCells: boolean;
  readonly name?: string;
};

const runProof = claudeProofQueue();

/** One opt-in test per isolated session, skipped unless the pinned Claude is installed. */
function proofTest(title: string, session: ProofSession): void {
  const skip =
    process.env["ELWOOD_NATIVE_QUESTIONS_PROOF"] === "1"
      ? claudeQuestionBinary()
        ? false
        : "requires pinned Claude and auth"
      : `set ELWOOD_NATIVE_QUESTIONS_PROOF=1 for valid-model turns (${session.rounds.join(", ")}) in an isolated session`;
  test(title, { skip, timeout: claudeProofTimeoutMs(session.rounds.length) }, (t) =>
    runProof(t.signal, (lifecycle) => proveClaudeQuestions(t, session, lifecycle)),
  );
}

proofTest(
  "C-E2E-18 native Claude grouped, free-text and checkbox answers preserve the ergonomic turn",
  { rounds: ["grouped", "text", "long-text", "checkbox"], blankCells: true },
);
// A named session's questionnaire closing rule replaces the notice row, so no blank cells stay.
proofTest("C-E2E-18 a named native Claude session raises and accepts a standalone checkbox", {
  rounds: ["checkbox"],
  blankCells: false,
  name: claudeQuestionSessionName,
});

/** Each question follows a notice posted at the idle composer and needs native acceptance. */
async function proveClaudeQuestions(
  t: TestContext,
  session: ProofSession,
  lifecycle: ClaudeProofLifecycle,
): Promise<void> {
  const { rounds: kinds, blankCells, name } = session;
  const events: ElwoodQuestionEvent[] = [];
  const normalized: Extract<ElwoodActivityEvent, { kind: "question" }>[] = [];
  const answerMarker = randomUUID();
  const texts = claudeProofTexts(answerMarker);
  const privateAnswers = [answerMarker, texts.note, texts.summary, texts.link];
  const answeredIds: string[] = [];
  const raisedScreens: string[] = [];
  let notices: ClaudeNoticeProof | undefined;
  let sandbox: Awaited<ReturnType<typeof nativeClaudeQuestionSandbox>> | undefined;
  let artifacts: ReturnType<typeof claudeQuestionArtifacts> | undefined;
  let unexpectedTools = 0;
  let primaryFailure = false;
  try {
    t.signal.throwIfAborted();
    sandbox = await nativeClaudeQuestionSandbox();
    t.signal.throwIfAborted();
    const proof = claudeNoticeProof(
      sandbox.press,
      () => active.session?.terminal.snapshot().text,
      t.signal,
    );
    notices = proof;
    const active = new ClaudeSession({
      cwd: sandbox.cwd,
      stateDir: sandbox.stateDir,
      model: "haiku",
      permissionMode: "default",
      autotrust: true,
      autoupdate: false,
      initialSize: { cols: 140, rows: 45 },
      ...(name === undefined ? {} : { name }),
      hooks: {
        PreToolUse(event) {
          if (event.tool_name === "AskUserQuestion") {
            proof.atQuestion();
            return undefined;
          }
          unexpectedTools++;
          return {
            permissionDecision: "deny",
            permissionDecisionReason: "Only questions in this proof.",
          };
        },
      },
    });
    artifacts = claudeQuestionArtifacts(
      () => active.session,
      sandbox.root,
      (message) => t.diagnostic(message),
    );
    active.on("terminal:data", artifacts.observe);
    active.on("terminal:data", proof.painted);
    active.on("question", (event) => {
      events.push(event);
      const screen = active.session?.terminal.snapshot().text;
      if (event.phase !== "raised" || screen === undefined) return;
      proof.raised(screen);
      raisedScreens.push(screen);
    });
    active.on("activity", (event) => {
      if (event.kind === "question") normalized.push(event);
    });
    const round = claudeQuestionRounds(active, events, t);
    const live = await lifecycle.start(active);
    await live.waitForStatus((status) => status === "ready", claudeReadyTimeoutMs);
    const rounds = claudeRoundsByKind(round, texts);
    // Rounds share the question waiter, the hook answer and the final-reply buffer: each settles first.
    for (const kind of kinds) {
      await proof.post();
      answeredIds.push(await rounds[kind]());
    }
    t.signal.throwIfAborted();
    t.assert.deepStrictEqual(
      proof.drawnAtQuestion,
      kinds.map(() => true),
    );
    t.assert.deepStrictEqual(
      [proof.residueWhenRaised, proof.footerKeptCells],
      [kinds.map(() => blankCells), kinds.includes("long-text")],
    );
    // A named questionnaire keeps the session's label in a border under its footer.
    const label = (screen: string) => /─ (.+) ─$/.exec(screen.split("\n").at(-1) ?? "")?.[1];
    t.assert.deepStrictEqual(
      raisedScreens.map(label),
      kinds.map(() => name),
    );
    t.assert.deepStrictEqual(
      events
        .filter((event) => event.phase === "closed")
        .map((event) => ({ id: event.request.id, reason: event.reason })),
      answeredIds.map((id) => ({ id, reason: "answered" })),
    );
    t.assert.deepStrictEqual(
      normalized.map((event) => event.question),
      events,
    );
    assertQuestionAnswerPrivacy(sandbox.stateDir, [...events, ...normalized], privateAnswers);
    t.assert.strictEqual(unexpectedTools, 0);
    t.assert.strictEqual(live.status, "ready");
    // The sandbox keeps the suite's private temp root (C-E2E-23), not the shared /tmp.
    const tempFolder = claudeTempFolder(realpathSync(sandbox.cwd));
    t.assert.deepStrictEqual(claudeTempFoldersNamed(defaultClaudeTempDir, tempFolder), [
      tempFolder,
    ]);
    t.assert.deepStrictEqual(claudeTempFoldersNamed("/tmp", tempFolder), []);
    t.diagnostic(
      `${claudeQuestionLabel}${name === undefined ? "" : ` (--name "${name}")`}: ${kinds.join(" + ")}; blank cells when raised: ${proof.residueWhenRaised.join(", ")}; native PostToolUse accepted each answer; original send returned final only.`,
    );
  } catch (error) {
    primaryFailure = true;
    if (sandbox) artifacts?.failure(sandbox.writes, events);
    throw error;
  } finally {
    notices?.stop();
    artifacts?.save();
    const disposed = sandbox;
    await lifecycle.finish(
      disposed
        ? [
            () =>
              assertQuestionAnswerPrivacy(
                disposed.stateDir,
                [...events, ...normalized],
                privateAnswers,
              ),
            () => disposed.dispose(),
            () => t.assert.strictEqual(existsSync(disposed.root), false),
          ]
        : [],
      primaryFailure,
      (message) => t.diagnostic(message),
    );
  }
}
