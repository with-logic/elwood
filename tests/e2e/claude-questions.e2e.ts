/** Native Claude grouped and multiline answers through the public API (PRD §5.10). */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import test from "node:test";
import {
  ClaudeSession,
  type ElwoodActivityEvent,
  type ElwoodQuestionEvent,
  type ElwoodQuestionRequest,
} from "../../src/index.ts";
import { defaultClaudeTempDir } from "./claude-home.ts";
import { claudeTempFolder, claudeTempFoldersNamed } from "./claude-temp.ts";
import { claudeQuestionArtifacts } from "./questions/claude-artifacts.ts";
import {
  claudeProofTimeoutMs,
  claudeQuestionLabel,
  claudeReadyTimeoutMs,
  groupedFinal,
  groupedPrompt,
  noteFirstLine,
  noteLastLine,
  textFinal,
  textPrompt,
} from "./questions/claude-cases.ts";
import { claudeProofLifecycle } from "./questions/claude-lifecycle.ts";
import { claudeQuestionRounds } from "./questions/claude-round.ts";
import { claudeQuestionBinary, nativeClaudeQuestionSandbox } from "./questions/claude-sandbox.ts";
import { assertQuestionAnswerPrivacy } from "./questions/proof-files.ts";

test("C-E2E-18 native Claude grouped and free-text answers preserve the ergonomic turn", {
  skip:
    process.env["ELWOOD_NATIVE_QUESTIONS_PROOF"] === "1"
      ? claudeQuestionBinary()
        ? false
        : "requires pinned Claude and auth"
      : "set ELWOOD_NATIVE_QUESTIONS_PROOF=1 for two isolated valid-model turns",
  timeout: claudeProofTimeoutMs,
}, async (t) => {
  function selected(
    question: ElwoodQuestionRequest["questions"][number],
    labels: readonly string[],
  ) {
    return labels.map((label) => {
      const option = question.options.find((item) => item.label === label);
      assert.ok(option, `Native option ${label} must be present`);
      return option.id;
    });
  }

  const events: ElwoodQuestionEvent[] = [];
  const normalized: Extract<ElwoodActivityEvent, { kind: "question" }>[] = [];
  const answerMarker = randomUUID();
  const note = `${noteFirstLine}_${answerMarker}\n${noteLastLine}`;
  const privateAnswers = [answerMarker, note];
  const answeredIds: string[] = [];
  let sandbox: Awaited<ReturnType<typeof nativeClaudeQuestionSandbox>> | undefined;
  let artifacts: ReturnType<typeof claudeQuestionArtifacts> | undefined;
  let unexpectedTools = 0;
  let primaryFailure = false;
  const lifecycle = claudeProofLifecycle(t.signal);
  try {
    t.signal.throwIfAborted();
    sandbox = await nativeClaudeQuestionSandbox();
    t.signal.throwIfAborted();
    const active = new ClaudeSession({
      cwd: sandbox.cwd,
      stateDir: sandbox.stateDir,
      model: "haiku",
      permissionMode: "default",
      autotrust: true,
      autoupdate: false,
      initialSize: { cols: 140, rows: 45 },
      hooks: {
        PreToolUse(event) {
          if (event.tool_name === "AskUserQuestion") return undefined;
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
    active.on("question", (event) => events.push(event));
    active.on("activity", (event) => {
      if (event.kind === "question") normalized.push(event);
    });
    const round = claudeQuestionRounds(active, events, t);
    const live = await lifecycle.start(active);
    await live.waitForStatus((status) => status === "ready", claudeReadyTimeoutMs);
    answeredIds.push(
      await round(
        groupedPrompt,
        (request) =>
          request.questions.map((question) => ({
            questionId: question.id,
            optionIds: selected(
              question,
              question.header === "Color" ? ["Blue"] : ["Logging", "Metrics"],
            ),
          })),
        { "Which test color?": "Blue", "Which test features?": "Logging, Metrics" },
        groupedFinal,
      ),
    );
    answeredIds.push(
      await round(
        textPrompt,
        (request) => request.questions.map((question) => ({ questionId: question.id, text: note })),
        { "Which test note?": note },
        textFinal,
      ),
    );
    t.signal.throwIfAborted();
    assert.deepEqual(
      events
        .filter((event) => event.phase === "closed")
        .map((event) => ({ id: event.request.id, reason: event.reason })),
      answeredIds.map((id) => ({ id, reason: "answered" })),
    );
    assert.deepEqual(
      normalized.map((event) => event.question),
      events,
    );
    assertQuestionAnswerPrivacy(sandbox.stateDir, [...events, ...normalized], privateAnswers);
    assert.equal(unexpectedTools, 0);
    assert.equal(live.status, "ready");
    // The sandbox keeps the suite's private temp root (C-E2E-23), not the shared /tmp.
    const tempFolder = claudeTempFolder(realpathSync(sandbox.cwd));
    assert.deepEqual(claudeTempFoldersNamed(defaultClaudeTempDir, tempFolder), [tempFolder]);
    assert.deepEqual(claudeTempFoldersNamed("/tmp", tempFolder), []);
    t.diagnostic(
      `${claudeQuestionLabel}: grouped single/multiple choices + multiline alternative text; native PostToolUse accepted both; original send returned final only.`,
    );
  } catch (error) {
    primaryFailure = true;
    if (sandbox) artifacts?.failure(sandbox.writes, events);
    throw error;
  } finally {
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
            () => assert.equal(existsSync(disposed.root), false),
          ]
        : [],
      primaryFailure,
      (message) => t.diagnostic(message),
    );
  }
});
