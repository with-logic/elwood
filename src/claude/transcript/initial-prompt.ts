/** Recover one authenticated prompt from an unchanged initial Claude transcript tail (C-API-63). */
import { isUtf8 } from "node:buffer";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { isRecord } from "../../core/predicates.ts";
import { claudePromptId } from "../hooks/prompt-id.ts";
import { userPromptText } from "./user-record.ts";

const maxBytes = 1024 * 1024;
const firstWindowBytes = 64 * 1024;
const maxRows = 4096;
const newline = 0x0a;
const userMarker = Buffer.from('"user"');
const backslash = 0x5c;

export type InitialUserPrompt = {
  readonly turnId: string;
  readonly text: string;
};

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

  /** A seed read failure belongs to the matching pending lookup in that same hook. */
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
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!sameInitialVersion(initial, fstatSync(fd))) return undefined;
    const scan = scanInitialTail(fd, initial.size);
    return sameInitialVersion(initial, fstatSync(fd)) ? scan : undefined;
  } finally {
    closeSync(fd);
  }
}

function scanInitialTail(fd: number, size: number): InitialPromptScan {
  const limit = Math.max(0, size - maxBytes);
  const recent = Math.max(0, size - firstWindowBytes);
  const first = scanWindow(fd, recent, size, maxRows);
  if (recent <= limit || first.result.prompt || first.rows === maxRows) return first.result;

  // The first unexamined delimiter ends the clipped row at the front of that read.
  // If the short window contains no delimiter, the older window must find its own.
  const older = scanWindow(fd, limit, first.unreadEnd ?? size, maxRows - first.rows);
  return { ...older.result, malformed: first.result.malformed || older.result.malformed };
}

type WindowScan = {
  readonly result: InitialPromptScan;
  readonly rows: number;
  readonly unreadEnd: number | undefined;
};

function scanWindow(fd: number, start: number, limit: number, remaining: number): WindowScan {
  const offset = Math.max(0, start - 1);
  const bytes = Buffer.allocUnsafe(limit - offset);
  if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) {
    throw Object.assign(new Error("The initial Claude transcript read was incomplete."), {
      code: "EIO",
    });
  }
  let malformed = false;
  let end = bytes.lastIndexOf(newline);
  let rows = 0;
  while (end > 0 && rows < remaining) {
    const boundary = bytes.lastIndexOf(newline, end - 1);
    if (boundary < 0 && start > 0) break;
    const row = bytes.subarray(boundary + 1, end);
    end = boundary;
    rows++;
    // An escaped discriminator is semantically identical after JSON parsing.
    if (!(row.includes(userMarker) || row.includes(backslash))) continue;
    const parsed = parseCandidate(row);
    if (parsed === null) malformed = true;
    else if (parsed !== undefined)
      return { result: { prompt: parsed, malformed }, rows, unreadEnd: undefined };
  }
  return { result: { malformed }, rows, unreadEnd: end < 0 ? undefined : offset + end + 1 };
}

/** A null result is a malformed candidate. Undefined means the record cannot supply text. */
function parseCandidate(bytes: Buffer): InitialUserPrompt | undefined | null {
  if (!isUtf8(bytes)) return null;
  try {
    const row: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(row) || row["type"] !== "user") return undefined;
    const turnId = claudePromptId(row["promptId"]);
    const text = userPromptText(row);
    return turnId !== undefined && text !== undefined ? { turnId, text } : undefined;
  } catch {
    return null;
  }
}
