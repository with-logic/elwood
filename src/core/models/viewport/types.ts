/** Selectable native picker items, including non-model disclosures (PRD §5.3, C-API-23/24). */
import type { PickerRow } from "../rows.ts";

export type ViewportItem =
  | { readonly kind: "model"; readonly row: PickerRow }
  | { readonly kind: "disclosure"; readonly expanded: boolean };

export type ModelViewport = {
  readonly items: readonly ViewportItem[];
  /** Number of selectable items above the window, not the number of models. */
  readonly offset: number;
  /** Codex's bare down-arrow announces more items without counting them. */
  readonly remainingBelow: number | undefined;
  readonly cursorItemIndex: number;
};
