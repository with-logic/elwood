/** Drive native question inputs and capture their resulting terminal evidence (PRD §12). */
import { setTimeout as delay } from "node:timers/promises";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexWorkingTitle } from "../../../src/codex/screen/working.ts";
import { record } from "../../../src/core/activity/meta.ts";
import type { TerminalSnapshot } from "../../../src/terminal/headless.ts";
import type { nativeCodexQuestionSandbox } from "./codex-sandbox.ts";
import { committedCodexQuestionRecords } from "./proof-files.ts";

/** Bound one model turn; polling merely waits for evidence, never authorizes input. */
const observationTimeoutMs = 90_000;
const observationPollMs = 50;
/** Pace physical keys so a native repaint can acknowledge each navigation step. */
const inputRepaintMs = 100;

type NativeCodexRecord = Readonly<Record<string, unknown>>;
type Sandbox = Awaited<ReturnType<typeof nativeCodexQuestionSandbox>>;
export type NativeCodexCapture = {
  readonly screens: Readonly<Record<string, TerminalSnapshot>>;
  readonly records: readonly NativeCodexRecord[];
  readonly writes: readonly string[];
};

export function nativeCodexQuestionDriver(sandbox: Sandbox) {
  const screens: Record<string, TerminalSnapshot> = {};
  const writes: string[] = [];
  const records = (): readonly NativeCodexRecord[] =>
    committedCodexQuestionRecords(sandbox.home).map(record);
  async function waitFor(check: () => boolean, timeoutMs = observationTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      const exited = sandbox.exitResult;
      if (exited)
        throw new Error(
          `Native Codex exited before the expected question evidence (code ${exited.exitCode}, signal ${exited.signal ?? "none"})`,
        );
      if (Date.now() >= deadline) throw new Error("Native question observation timed out");
      await delay(observationPollMs);
    }
    await sandbox.terminal.settled();
  }
  async function capture(name: string): Promise<void> {
    await sandbox.terminal.settled();
    const snapshot = sandbox.terminal.snapshot();
    screens[name] = {
      ...snapshot,
      text: snapshot.text.replaceAll(sandbox.root, "<SANDBOX>"),
      lines: snapshot.lines.map((line) => line.replaceAll(sandbox.root, "<SANDBOX>")),
    };
  }
  async function write(input: string): Promise<void> {
    writes.push(input);
    sandbox.pty.write(input);
    await delay(inputRepaintMs);
    await sandbox.terminal.settled();
  }
  return {
    records,
    waitFor,
    capture,
    write,
    waitForScreen: (check: (text: string) => boolean) =>
      waitFor(() => check(sandbox.terminal.snapshot().text)),
    async ready() {
      const empty = () =>
        codexEmptyInputFrame(sandbox.terminal) !== undefined &&
        !codexWorkingTitle.test(sandbox.terminal.title);
      await waitFor(empty);
      // The cold placeholder is byte-identical to a live composer. Pinned 0.163.0
      // handles /pwd locally; its response proves the input loop handled a command
      // before this driver submits /plan or any quota-bearing question prompt.
      await write("/pwd\r");
      await waitFor(() =>
        sandbox.terminal.snapshot().text.includes(`Current working directory: ${sandbox.cwd}`),
      );
      await waitFor(empty);
    },
    async prompt(text: string) {
      await write(`\x1b[200~${text}\x1b[201~`);
      await write("\r");
    },
    result(): NativeCodexCapture {
      return {
        screens,
        records: records().map((item) =>
          record(JSON.parse(JSON.stringify(item).replaceAll(sandbox.root, "<SANDBOX>"))),
        ),
        writes,
      };
    },
  };
}
