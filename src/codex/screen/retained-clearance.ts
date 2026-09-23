/** Preserve update holds across overlays on an old composer (intended C-CODEX-12 wiring). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerRow } from "./clearance.ts";

/** Production shares the immutable snapshot already used for live clearance. */
export type RetainedFrameReader = () => {
  readonly text: string;
  readonly lines: readonly string[];
};
type ComposerProvenance = { readonly rows: readonly string[]; readonly at: number };

/** Observes every frame; its result is whether a previously seen update still holds input. */
export class CodexRetainedComposerHold {
  private holding = false;
  private priorComposer: ComposerProvenance | undefined;
  // undefined: no retained provenance; null: composer evidence at update entry
  // without a verified idle prelude; array: the verified pre-update prelude.
  private frozenPrelude: readonly string[] | null | undefined;
  private readonly isClear: TrustClearance;
  private readonly readFrame: RetainedFrameReader | undefined;
  constructor(isClear: TrustClearance, readFrame?: RetainedFrameReader) {
    this.isClear = isClear;
    this.readFrame = readFrame;
  }

  observe(text: string, updateActive: boolean): boolean {
    const frame = this.readFrame?.();
    const rows = frame?.text === text ? frame.lines : text.split("\n");
    const liveClear = this.isClear(text);
    const composer = codexComposerRow(rows, liveClear);
    if (updateActive && !this.holding) {
      this.frozenPrelude =
        composer < 0
          ? undefined
          : this.priorComposer === undefined
            ? null
            : prelude(this.priorComposer);
      this.holding = true;
    }
    // Loss of verified composer evidence expires the old provenance, even if a
    // welcome-only prompt remains visible with its cursor hidden. Later verified
    // composer evidence can then clear newly loaded startup/resume history.
    if (composer < 0) {
      this.priorComposer = undefined;
      this.frozenPrelude = undefined;
    }
    if (updateActive) return true;
    if (composer < 0 || !liveClear) return this.holding;
    const current = { rows, at: composer };
    if (this.holding && !this.isCompatibleWithFrozenPrelude(prelude(current))) return true;
    this.holding = false;
    this.frozenPrelude = undefined;
    // Keep immutable snapshot provenance; normalize its history only if an update
    // arrives. Ordinary output no longer copies and trims the whole prelude.
    this.priorComposer = current;
    return false;
  }

  private isCompatibleWithFrozenPrelude(prelude: readonly string[]): boolean {
    const frozen = this.frozenPrelude;
    if (frozen === undefined) return true;
    if (frozen === null || prelude.length > frozen.length) return false;
    // Scrolling may remove old history from the top, but cannot introduce replacement text.
    const offset = frozen.length - prelude.length;
    return prelude.every((row, index) => row === frozen[offset + index]);
  }
}

function prelude({ rows, at }: ComposerProvenance): readonly string[] {
  return rows
    .slice(0, at)
    .map((row) => row.trimEnd())
    .filter(Boolean);
}
