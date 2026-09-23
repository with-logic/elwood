/** Preserve update holds across overlays on an old composer (intended C-CODEX-12 wiring). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerRow } from "./clearance.ts";

/** Observes every frame; its result is whether a previously seen update still holds input. */
export class CodexRetainedComposerHold {
  private holding = false;
  private priorPrelude: readonly string[] | undefined;
  // null means a composer existed at entry without a prior verified idle snapshot.
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
    // Once the old composer disappears, a later native composer has new provenance.
    // This permits startup/resume history that did not exist before the update.
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
