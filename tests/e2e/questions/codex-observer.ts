/** Native question captures and committed-rollout inspection (PRD §12). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexWorkingTitle } from "../../../src/codex/screen/working.ts";
import { record } from "../../../src/core/activity/meta.ts";
import type { TerminalSnapshot } from "../../../src/terminal/headless.ts";
import type { nativeCodexQuestionSandbox } from "./codex-sandbox.ts";

type Sandbox = Awaited<ReturnType<typeof nativeCodexQuestionSandbox>>;
export type NativeCodexRecord = Readonly<Record<string, unknown>>;
export type NativeCodexCapture = {
  readonly screens: Readonly<Record<string, TerminalSnapshot>>;
  readonly records: readonly NativeCodexRecord[];
  readonly writes: readonly string[];
};

function files(dir: string): readonly string[] {
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      )
    : [];
}

export function nativeCodexQuestionObserver(sandbox: Sandbox) {
  const screens: Record<string, TerminalSnapshot> = {};
  const writes: string[] = [];
  const records = (): readonly NativeCodexRecord[] =>
    files(join(sandbox.home, "sessions"))
      .filter((path) => path.endsWith(".jsonl"))
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .slice(0, -1)
          .filter(Boolean)
          .map((line) => record(JSON.parse(line))),
      );
  async function waitFor(check: () => boolean, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error("Native question observation timed out");
      await delay(50);
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
    await delay(100);
    await sandbox.terminal.settled();
  }
  return {
    records,
    waitFor,
    capture,
    write,
    waitForScreen: (check: (text: string) => boolean) =>
      waitFor(() => check(sandbox.terminal.snapshot().text)),
    ready: () =>
      waitFor(
        () =>
          codexEmptyInputFrame(sandbox.terminal) !== undefined &&
          !codexWorkingTitle.test(sandbox.terminal.title),
      ),
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

export function nativeCodexPayload(item: NativeCodexRecord): Record<string, unknown> {
  return record(item["payload"]);
}

export function nativeCodexFunctionOutput(
  records: readonly NativeCodexRecord[],
  name: string,
): string | undefined {
  const call = records.map(nativeCodexPayload).find((item) => item["name"] === name);
  const output = records
    .map(nativeCodexPayload)
    .find(
      (item) => item["type"] === "function_call_output" && item["call_id"] === call?.["call_id"],
    )?.["output"];
  return typeof output === "string" ? output : undefined;
}
