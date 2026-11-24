/** Recover one authenticated prompt from an unchanged initial Claude transcript tail (C-API-63). */
import { isUtf8 } from "node:buffer";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { isRecord } from "../../core/predicates.ts";
import { claudePromptId } from "../hooks/prompt-id.ts";
import { userPromptText } from "./user-record.ts";

const maxBytes = 1024 * 1024;
const maxRows = 4096;
const newline = 0x0a;
const userMarker = Buffer.from('"user"');

export type InitialUserPrompt = {
  readonly turnId: string;
  readonly text: string;
};

type InitialPromptScan = {
  readonly prompt?: InitialUserPrompt;
  readonly malformed: boolean;
};

export class InitialClaudePrompt {
  private state: "fresh" | "closed" | { readonly retryFor: string } = "fresh";
  private readonly registration: Stats | undefined;
  constructor(registration: Stats | undefined) {
    this.registration = registration;
  }

  take(path: string, requestingTurnId: string): InitialPromptScan | undefined {
    const initial = this.registration;
    const state = this.state;
    if (state === "closed" || !initial?.isFile() || initial.size === 0) return undefined;
    if (state !== "fresh" && state.retryFor !== requestingTurnId) return undefined;
    this.state = state === "fresh" ? { retryFor: requestingTurnId } : "closed";
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
    const start = Math.max(0, initial.size - maxBytes);
    const offset = Math.max(0, start - 1); // one byte of evidence for the first row boundary
    const bytes = Buffer.allocUnsafe(initial.size - offset);
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    if (count !== bytes.length)
      throw Object.assign(new Error("The initial Claude transcript read was incomplete."), {
        code: "EIO",
      });
    if (!sameInitialVersion(initial, fstatSync(fd))) return undefined;
    return latestCommittedPrompt(bytes, start !== 0);
  } finally {
    closeSync(fd);
  }
}

function latestCommittedPrompt(bytes: Buffer, clipped: boolean): InitialPromptScan {
  let malformed = false;
  let end = bytes.lastIndexOf(newline);
  for (let count = 0; end > 0 && count < maxRows; count++) {
    const boundary = bytes.lastIndexOf(newline, end - 1);
    if (boundary < 0 && clipped) break;
    const row = bytes.subarray(boundary + 1, end);
    end = boundary;
    if (!row.includes(userMarker)) continue;
    const parsed = parseCandidate(row);
    if (parsed === null) malformed = true;
    else if (parsed !== undefined) return { prompt: parsed, malformed };
  }
  return { malformed };
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
