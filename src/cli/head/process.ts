/** Adapts Node's terminal stdin/stderr into the CLI head boundary (§12A.6, C-CLI-18). */

import { defaultTerminalSize } from "../../core/defaults.ts";
import type { TerminalSize } from "../../core/types.ts";
import type { CliHeadTarget } from "./types.ts";

type Method = (...args: readonly unknown[]) => unknown;
type Candidate = Record<string, unknown>;

export function createProcessHeadTarget(
  stdin: unknown,
  stderr: unknown,
): CliHeadTarget | undefined {
  if (!(isCandidate(stdin) && isCandidate(stderr))) return undefined;
  if (stdin["isTTY"] !== true || stderr["isTTY"] !== true) return undefined;
  const setRawMode = method(stdin, "setRawMode");
  const resume = method(stdin, "resume");
  const pause = method(stdin, "pause");
  const inputOn = method(stdin, "on");
  const inputOff = method(stdin, "off");
  const resizeOn = method(stderr, "on");
  const resizeOff = method(stderr, "off");
  const write = method(stderr, "write");
  const once = method(stderr, "once");
  if (
    !(
      setRawMode &&
      resume &&
      pause &&
      inputOn &&
      inputOff &&
      resizeOn &&
      resizeOff &&
      write &&
      once
    )
  ) {
    return undefined;
  }
  const size = () => terminalSize(stderr);
  let inputFailure: unknown;
  const recordInputFailure = (error: unknown) => {
    if (!isTerminalGone(error)) inputFailure = error;
  };
  return {
    output: stderr as CliHeadTarget["output"],
    size,
    isRaw: () => stdin["isRaw"] === true,
    setRawMode: (enabled) => setTerminalRawMode(setRawMode, stdin, enabled),
    resume: () => void resume.call(stdin),
    pause: () => void pause.call(stdin),
    onInput: (handler) => {
      inputOn.call(stdin, "error", recordInputFailure);
      try {
        inputOn.call(stdin, "data", handler);
      } catch (error) {
        inputOff.call(stdin, "error", recordInputFailure);
        throw error;
      }
      return () => {
        inputOff.call(stdin, "data", handler);
        inputOff.call(stdin, "error", recordInputFailure);
        if (inputFailure !== undefined) throw inputFailure;
      };
    },
    onResize: (handler) => bind(resizeOn, resizeOff, stderr, "resize", () => handler(size())),
  };
}

const terminalGoneCodes = new Set(["EBADF", "EIO", "ENXIO"]);

function setTerminalRawMode(method: Method, stdin: Candidate, enabled: boolean): void {
  try {
    method.call(stdin, enabled);
  } catch (error) {
    if (!enabled && isTerminalGone(error)) return;
    throw error;
  }
}

function isTerminalGone(error: unknown): boolean {
  return terminalGoneCodes.has((error as NodeJS.ErrnoException).code ?? "");
}

function terminalSize(stderr: Candidate): TerminalSize {
  const cols = dimension(stderr["columns"], defaultTerminalSize.cols);
  const rows = dimension(stderr["rows"], defaultTerminalSize.rows);
  return { cols, rows };
}

function dimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function bind(
  on: Method,
  off: Method,
  owner: Candidate,
  event: string,
  handler: (...args: never[]) => void,
): () => void {
  const listener = handler as (...args: unknown[]) => void;
  on.call(owner, event, listener);
  return () => void off.call(owner, event, listener);
}

function method(value: Candidate, key: string): Method | undefined {
  const candidate = value[key];
  return typeof candidate === "function" ? (candidate as Method) : undefined;
}

function isCandidate(value: unknown): value is Candidate {
  return typeof value === "object" && value !== null;
}
