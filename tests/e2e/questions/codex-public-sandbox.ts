/** Bind the private current Codex fixture to the public Elwood API (PRD §12). */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readQuestionFrame } from "../../../src/core/questions/input.ts";
import { CodexSession, type ElwoodQuestionRequest } from "../../../src/index.ts";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../../src/runtime/seams.ts";
import { shellQuote } from "../../../src/runtime/shell.ts";
import { subscribeRender } from "../../../src/terminal/cursor.ts";
import type { ElwoodTerminal } from "../../../src/terminal/headless.ts";
import {
  nativeCodexQuestionFiles,
  nativeQuestionSize,
  questionCodexModel,
} from "./codex-sandbox.ts";
import { committedCodexQuestionRecords, privateQuestionArtifacts } from "./proof-files.ts";

/** An answer choosing `label` in the request's first question only; later questions are ignored. */
export function publicCodexOptionAnswer(request: ElwoodQuestionRequest, label: string) {
  const question = request.questions[0];
  if (!question) throw new Error("Native question request contains no questions");
  const option = question.options.find((item) => item.label === label);
  if (!option) throw new Error(`Native question did not offer ${label}`);
  return { questionId: question.id, optionIds: [option.id] };
}

/** An answer with `text` for the request's first question only; later questions are ignored. */
export function publicCodexTextAnswer(request: ElwoodQuestionRequest, text: string) {
  const question = request.questions[0];
  if (!question) throw new Error("Native question request contains no questions");
  return { questionId: question.id, text };
}

/** A session on the pinned Codex and model inside `sandbox`, sized like the captures. */
export function publicCodexQuestionSession(sandbox: {
  readonly cwd: string;
  readonly stateDir: string;
}): CodexSession {
  return new CodexSession({
    cwd: sandbox.cwd,
    stateDir: sandbox.stateDir,
    model: questionCodexModel,
    reasoningEffort: "low",
    autotrust: true,
    autoupdate: false,
    sandbox: "read-only",
    approvalPolicy: "never",
    initialSize: nativeQuestionSize,
  });
}

const publicQuestionTimeoutMs = 60_000;
const publicQuestionPollMs = 25;

export async function waitForPublicCodexQuestion(
  check: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + publicQuestionTimeoutMs;
  while (!check()) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error("Native public question proof timed out");
    await delay(publicQuestionPollMs, undefined, { signal });
  }
}

/** Waits for `check`, failing at once if `reply` settles first: a turn must raise its expected
 * questions before it can finish or fail. */
export async function waitForPublicCodexQuestionsBeforeReply(
  check: () => boolean,
  reply: Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  const waiting = new AbortController();
  const abort = () => waiting.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await Promise.race([
      waitForPublicCodexQuestion(check, waiting.signal),
      reply.then(() => {
        if (!check()) throw new Error("Native turn finished before raising expected questions");
      }),
    ]);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abort);
    waiting.abort();
  }
}

export async function publicCodexQuestionSandbox() {
  const files = await nativeCodexQuestionFiles();
  try {
    const stateDir = join(files.root, "state");
    const writes: string[] = [];
    mkdirSync(stateDir, { mode: 0o700 });
    const pin = (args: readonly string[]) =>
      args.map((arg, index) =>
        index === args.length - 1
          ? `export CODEX_HOME=${shellQuote(files.home)} ZDOTDIR=${shellQuote(files.home)} PATH=${shellQuote(dirname(files.binary))}:"$PATH"; ${arg}`
          : arg,
      );
    setCommandRunnerForTests((command, args) =>
      runProbe("env", [`CODEX_HOME=${files.home}`, `ZDOTDIR=${files.home}`, command, ...pin(args)]),
    );
    setPtyFactoryForTests((options) => {
      const pty = nodePtyFactory({
        ...options,
        args: pin(options.args),
        env: { ...options.env, CODEX_HOME: files.home, ZDOTDIR: files.home },
      });
      return {
        ...pty,
        write(data) {
          writes.push(typeof data === "string" ? data : Buffer.from(data).toString());
          pty.write(data);
        },
      };
    });
    return {
      ...files,
      stateDir,
      writes,
      dispose() {
        resetRuntimeSeamsForTests();
        files.dispose();
      },
    };
  } catch (error) {
    resetRuntimeSeamsForTests();
    try {
      files.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex question setup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Retain exact hidden-cursor frames from this bounded private proof until terminal disposal. */
export function captureCodexQuestionCursor(terminal: ElwoodTerminal, root: string) {
  const artifacts = privateQuestionArtifacts(root);
  let captureFailure: Error | undefined;
  const dispose = subscribeRender(terminal, () => {
    try {
      const frame = readQuestionFrame(terminal);
      if (
        frame?.cursorVisible === false &&
        frame.text.includes("enter submit   ⌃] skip") &&
        frame.cursorRow < frame.lines.lastIndexOf("• Queued follow-up inputs")
      )
        artifacts.write("parked-frame", JSON.stringify(frame).replaceAll(root, "<SANDBOX>"));
    } catch (error) {
      captureFailure ??= error instanceof Error ? error : new Error("Cursor capture failed");
    }
  });
  return {
    dispose,
    assertNoCaptureError() {
      if (captureFailure) throw captureFailure;
    },
  };
}

/** Inspect only complete committed rollout lines from this private proof session. */
export const publicCodexQuestionRecords = committedCodexQuestionRecords;
