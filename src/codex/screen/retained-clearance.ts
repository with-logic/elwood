/** Preserve update holds across overlays on an old composer (intended C-CODEX-12 wiring). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerRow } from "./clearance.ts";

/** Observes every frame; its result is whether a previously seen update still holds input. */
export class CodexRetainedComposerHold {
  private holding = false;
  private priorPrelude: readonly string[] | undefined;
  // undefined: no retained provenance; null: composer evidence at update entry
  // without a verified idle prelude; array: the verified pre-update prelude.
  private frozenPrelude: readonly string[] | null | undefined;
  private readonly isClear: TrustClearance;
  constructor(isClear: TrustClearance) {
    this.isClear = isClear;
  }

  observe(text: string, updateActive: boolean): boolean {
    const rows = text.split("\n");
    const liveClear = this.isClear(text);
    const composer = codexComposerRow(rows, liveClear);
    if (updateActive && !this.holding) {
      this.frozenPrelude = composer < 0 ? undefined : (this.priorPrelude ?? null);
      this.holding = true;
    }
    // Loss of verified composer evidence expires the old provenance, even if a
    // welcome-only prompt remains visible with its cursor hidden. Later verified
    // composer evidence can then clear newly loaded startup/resume history.
    if (composer < 0) {
      this.priorPrelude = undefined;
      this.frozenPrelude = undefined;
    }
    if (updateActive) return true;
    if (composer < 0 || !liveClear) return this.holding;
    const prelude = rows
      .slice(0, composer)
      .map((row) => row.trimEnd())
      .filter(Boolean);
    if (this.holding && !this.isCompatibleWithFrozenPrelude(prelude)) return true;
    this.holding = false;
    this.frozenPrelude = undefined;
    this.priorPrelude = prelude;
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
