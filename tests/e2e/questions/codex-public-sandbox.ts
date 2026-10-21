/** Bind the private current Codex fixture to the public Elwood API (PRD §12). */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readQuestionFrame } from "../../../src/core/questions/input.ts";
import type { ElwoodQuestionRequest } from "../../../src/index.ts";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../../src/runtime/seams.ts";
import { shellQuote } from "../../../src/runtime/shell.ts";
import { subscribeRender } from "../../../src/terminal/cursor.ts";
import type { ElwoodTerminal } from "../../../src/terminal/headless.ts";
import { nativeCodexQuestionFiles } from "./codex-sandbox.ts";
import { committedCodexQuestionRecords, privateQuestionArtifacts } from "./proof-files.ts";

export function publicCodexBlueAnswer(request: ElwoodQuestionRequest) {
  const question = request.questions[0];
  if (!question) throw new Error("Native question request contains no questions");
  const option = question.options.find((item) => item.label === "Blue");
  if (!option) throw new Error("Native question did not offer Blue");
  return { questionId: question.id, optionIds: [option.id] };
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
