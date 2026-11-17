/** Correlate committed Claude records within retained-identity limits (PRD §5.4). */
import { isRecord } from "../../core/predicates.ts";
import type { BaselinePrompt } from "./baseline.ts";

const maxTurnRecords = 4_096;
const maxIdentifierBytes = 1_024;
const maxPathBytes = 4_096;
const maxPaths = 128;
const maxRetainedBytes = 1024 * 1024;
type RetainedIdentity = { readonly turnId: string; readonly bytes: number };
type TranscriptIdentityState = {
  initialized: boolean;
  bytes: number;
  readonly records: Map<string, RetainedIdentity>;
};

export class ClaudeTranscriptTurns {
  private readonly paths = new Map<string, TranscriptIdentityState>();
  private bytes = 0;
  private disabled = false;

  /** Bind only the native-ID-matching user prompt already within the cursor's EOF baseline. */
  seed(
    path: string,
    turnId: string | undefined,
    readBaseline: () => BaselinePrompt | undefined,
  ): void {
    if (turnId === undefined) return;
    const state = this.state(path);
    if (state === undefined || state.initialized) return;
    state.initialized = true;
    const prompt = readBaseline();
    if (prompt?.["promptId"] === turnId) this.observe(path, prompt);
  }

  /** Native IDs win; every inherited ID needs a known parent UUID, never a pending hook. */
  observe(path: string, item: unknown): string | undefined {
    if (!isRecord(item)) return undefined;
    const native = nonempty(item["promptId"]);
    const parent = nonempty(item["parentUuid"]);
    const uuid = nonempty(item["uuid"]);
    if (![native, parent, uuid].every(withinIdentifierLimit)) return this.disable();
    const state = this.state(path);
    if (state === undefined) return undefined;
    const inherited = parent === undefined ? undefined : state.records.get(parent)?.turnId;
    const turnId = native ?? inherited;
    if (native !== undefined) state.initialized = true;
    if (uuid !== undefined && turnId !== undefined && !this.remember(state, uuid, turnId))
      return undefined;
    return turnId;
  }

  forget(path: string): void {
    const state = this.paths.get(path);
    if (state === undefined) return;
    this.bytes -= state.bytes;
    this.paths.delete(path);
  }

  private remember(state: TranscriptIdentityState, uuid: string, turnId: string): boolean {
    this.remove(state, uuid);
    if (state.records.size === maxTurnRecords)
      this.remove(state, state.records.keys().next().value as string);
    const bytes = Buffer.byteLength(uuid, "utf8") + Buffer.byteLength(turnId, "utf8");
    if (this.bytes + bytes > maxRetainedBytes) {
      this.disable();
      return false;
    }
    state.records.set(uuid, { turnId, bytes });
    state.bytes += bytes;
    this.bytes += bytes;
    return true;
  }

  private remove(state: TranscriptIdentityState, uuid: string): void {
    const retained = state.records.get(uuid);
    if (retained === undefined) return;
    state.bytes -= retained.bytes;
    this.bytes -= retained.bytes;
    state.records.delete(uuid);
  }

  private state(path: string): TranscriptIdentityState | undefined {
    if (this.disabled) return undefined;
    let state = this.paths.get(path);
    if (state === undefined) {
      const bytes = Buffer.byteLength(path, "utf8");
      if (
        bytes > maxPathBytes ||
        this.paths.size === maxPaths ||
        this.bytes + bytes > maxRetainedBytes
      )
        return this.disable();
      state = { initialized: false, bytes, records: new Map() };
      this.paths.set(path, state);
      this.bytes += bytes;
    }
    return state;
  }

  /** A single lifetime latch bounds failure state even when new hostile paths keep arriving. */
  private disable(): undefined {
    this.disabled = true;
    this.paths.clear();
    this.bytes = 0;
    return undefined;
  }
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withinIdentifierLimit(value: string | undefined): boolean {
  return value === undefined || Buffer.byteLength(value, "utf8") <= maxIdentifierBytes;
}
