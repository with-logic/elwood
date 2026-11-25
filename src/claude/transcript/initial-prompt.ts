/** Recover one authenticated prompt from an unchanged initial Claude transcript tail (C-API-63). */
import { isUtf8 } from "node:buffer";
import { fstatSync, readSync, type Stats, statSync } from "node:fs";
import { isRecord } from "../../core/predicates.ts";
import { withTranscriptFile } from "../../core/transcript/cursor-io.ts";
import { claudePromptId } from "../hooks/prompt-id.ts";
import { type UserPromptRecord, userPromptRecord } from "./user-record.ts";

const maxBytes = 1024 * 1024;
const firstWindowBytes = 64 * 1024;
const maxRows = 4096;
const newline = 0x0a;
const userMarker = Buffer.from('"user"');
const backslash = 0x5c;

export type InitialUserPrompt = UserPromptRecord & { readonly turnId: string };

type InitialPromptScan = {
  readonly prompt?: InitialUserPrompt;
  readonly malformed: boolean;
};

export class InitialClaudePrompt {
  private state: "fresh" | "closed" | { readonly retryFor: object } = "fresh";
  private readonly registration: Stats | undefined;
  constructor(registration: Stats | undefined) {
    this.registration = registration;
  }

  /** Reserve one retry for this retained authenticated submission, including later scans. */
  recordAttempt(pendingToken: object): boolean {
    const state = this.state;
    if (state === "closed" || (state !== "fresh" && state.retryFor !== pendingToken)) return false;
    this.state = state === "fresh" ? { retryFor: pendingToken } : "closed";
    return true;
  }

  take(path: string, pendingToken: object): InitialPromptScan | undefined {
    const initial = this.registration;
    if (!initial?.isFile() || initial.size === 0 || !this.recordAttempt(pendingToken))
      return undefined;
    const found = readInitialPrompt(path, initial);
    this.state = "closed";
    return found;
  }
}

function sameInitialVersion(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readInitialPrompt(path: string, initial: Stats): InitialPromptScan | undefined {
  return withTranscriptFile(path, (fd, opened) => {
    if (!sameInitialVersion(initial, opened)) return undefined;
    const scan = scanInitialTail(fd, initial.size);
    if (!sameInitialVersion(initial, fstatSync(fd))) return undefined;
    return sameInitialVersion(initial, statSync(path)) ? scan : undefined;
  });
}

function scanInitialTail(fd: number, size: number): InitialPromptScan {
  const tailStartOffset = Math.max(0, size - maxBytes);
  const recentStartOffset = Math.max(0, size - firstWindowBytes);
  const first = scanWindow(fd, recentStartOffset, size, maxRows);
  const firstWindowCoversTail = recentStartOffset <= tailStartOffset;
  const foundPrompt = first.result.prompt !== undefined;
  const rowBudgetExhausted = first.rows === maxRows;
  if (firstWindowCoversTail || foundPrompt || rowBudgetExhausted) return first.result;

  // The first unexamined delimiter ends the clipped row at the front of that read.
  // If the short window contains no delimiter, the older window must find its own.
  const older = scanWindow(
    fd,
    tailStartOffset,
    first.unreadEndOffset ?? size,
    maxRows - first.rows,
  );
  return { ...older.result, malformed: first.result.malformed || older.result.malformed };
}

type WindowScan = {
  readonly result: InitialPromptScan;
  readonly rows: number;
  readonly unreadEndOffset: number | undefined;
};

function scanWindow(
  fd: number,
  windowStartOffset: number,
  windowEndOffset: number,
  remainingRows: number,
): WindowScan {
  const offset = Math.max(0, windowStartOffset - 1);
  const bytes = Buffer.allocUnsafe(windowEndOffset - offset);
  if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) {
    throw Object.assign(new Error("The initial Claude transcript read was incomplete."), {
      code: "EIO",
    });
  }
  let malformed = false;
  let end = bytes.lastIndexOf(newline);
  let rows = 0;
  while (end > 0 && rows < remainingRows) {
    const boundary = bytes.lastIndexOf(newline, end - 1);
    if (boundary < 0 && windowStartOffset > 0) break;
    const row = bytes.subarray(boundary + 1, end);
    end = boundary;
    rows++;
    // An escaped discriminator is semantically identical after JSON parsing.
    if (!(row.includes(userMarker) || row.includes(backslash))) continue;
    const parsed = parseCandidate(row);
    if (parsed === null) malformed = true;
    else if (parsed !== undefined)
      return { result: { prompt: parsed, malformed }, rows, unreadEndOffset: undefined };
  }
  return { result: { malformed }, rows, unreadEndOffset: end < 0 ? undefined : offset + end + 1 };
}

/** A null result is a malformed candidate. Undefined means the record cannot supply text. */
function parseCandidate(bytes: Buffer): InitialUserPrompt | undefined | null {
  if (!isUtf8(bytes)) return null;
  try {
    const row: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(row) || row["type"] !== "user") return undefined;
    const turnId = claudePromptId(row["promptId"]);
    const prompt = userPromptRecord(row);
    return turnId !== undefined && prompt !== undefined ? { turnId, ...prompt } : undefined;
  } catch {
    return null;
  }
}
