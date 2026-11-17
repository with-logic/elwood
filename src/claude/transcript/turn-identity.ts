/** Correlate committed Claude records with native prompt identities (PRD §5.4). */
import { isRecord } from "../../core/predicates.ts";

const maxTurnRecords = 4_096;
type TranscriptIdentityState = {
  initialized: boolean;
  seed: string | undefined;
  readonly records: Map<string, string>;
};

export class ClaudeTranscriptTurns {
  private readonly paths = new Map<string, TranscriptIdentityState>();

  /** A first UserPromptSubmit can arrive after its user record was baselined at EOF. */
  seed(path: string, turnId: string | undefined): void {
    if (turnId === undefined) return;
    const state = this.state(path);
    if (!state.initialized) {
      state.initialized = true;
      state.seed = turnId;
    }
  }

  /** Native IDs win; other records require an identified parent. The one-use hook
   * seed binds a parent already baselined at EOF. A missing or evicted link stays
   * untagged, so late records cannot inherit a successor merely by arriving later. */
  observe(path: string, item: unknown): string | undefined {
    if (!isRecord(item)) return undefined;
    const state = this.state(path);
    const native = nonempty(item["promptId"]);
    const parent = nonempty(item["parentUuid"]);
    const inherited = parent === undefined ? undefined : (state.records.get(parent) ?? state.seed);
    const turnId = native ?? inherited;
    if (native !== undefined) {
      state.seed = undefined;
      state.initialized = true;
    } else if (parent !== undefined && state.seed !== undefined) {
      this.remember(state, parent, state.seed);
      state.seed = undefined;
    }
    const uuid = nonempty(item["uuid"]);
    if (uuid !== undefined && turnId !== undefined) this.remember(state, uuid, turnId);
    return turnId;
  }

  forget(path: string): void {
    this.paths.delete(path);
  }

  private remember(state: TranscriptIdentityState, uuid: string, turnId: string): void {
    state.records.set(uuid, turnId);
    if (state.records.size > maxTurnRecords)
      state.records.delete(state.records.keys().next().value as string);
  }

  private state(path: string): TranscriptIdentityState {
    let state = this.paths.get(path);
    if (state === undefined) {
      state = { initialized: false, seed: undefined, records: new Map() };
      this.paths.set(path, state);
    }
    return state;
  }
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
