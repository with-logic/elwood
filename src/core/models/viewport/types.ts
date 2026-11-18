/** Selectable native picker items, including non-model disclosures (PRD §5.3, C-API-23/24). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import type { DialogGrammar } from "../dialog-region.ts";
import type { PickerRow } from "../rows.ts";

/** Each adapter owns its native window markers, disclosures, and control text. */
export type ViewportGrammar = DialogGrammar & {
  readonly agent: ElwoodAgentKind;
  readonly selector?: (label: string) => string | null;
  readonly marker: RegExp;
  readonly countedMarkers: boolean;
  readonly partialMarker: RegExp;
  readonly markerSuffix: string;
  readonly disclosure?: {
    readonly row: RegExp;
    readonly partial: RegExp;
    readonly label: string;
  };
  readonly validTail: (
    lines: readonly string[],
    footer: string,
    selectedDisclosureExpanded: boolean | undefined,
  ) => boolean;
  readonly prefixTail: (lines: readonly string[]) => boolean;
};

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
