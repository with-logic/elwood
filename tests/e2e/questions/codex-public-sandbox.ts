/** Bind the private current Codex fixture to the public Elwood API (PRD §12). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readQuestionFrame } from "../../../src/core/questions/transaction.ts";
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

export function publicCodexBlueAnswer(request: ElwoodQuestionRequest) {
  const question = request.questions[0]!;
  const option = question.options.find((item) => item.label === "Blue");
  if (!option) throw new Error("Native question did not offer Blue");
  return { questionId: question.id, optionIds: [option.id] };
}

export async function waitForPublicCodexQuestion(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Native public question proof timed out");
    await delay(25);
  }
}

export async function publicCodexQuestionSandbox() {
  const files = await nativeCodexQuestionFiles();
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
}

/** Retain exact hidden-cursor frames from this bounded private proof until terminal disposal. */
export function captureCodexQuestionCursor(terminal: ElwoodTerminal, root: string): void {
  subscribeRender(terminal, () => {
    const frame = readQuestionFrame(terminal);
    if (
      frame?.cursorVisible === false &&
      frame.text.includes("enter submit   ⌃] skip") &&
      frame.cursorRow < frame.lines.lastIndexOf("• Queued follow-up inputs")
    )
      writeFileSync(
        "/tmp/elwood-codex-native-parked-frame.json",
        JSON.stringify(frame).replaceAll(root, "<SANDBOX>"),
      );
  });
}

/** Inspect only complete committed rollout lines from this private proof session. */
export function publicCodexQuestionRecords(home: string): readonly unknown[] {
  const walk = (dir: string): readonly string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
          item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)],
        )
      : [];
  return walk(join(home, "sessions"))
    .filter((path) => path.endsWith(".jsonl"))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}
