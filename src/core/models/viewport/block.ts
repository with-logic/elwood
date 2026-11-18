/** The contiguous selectable block inside a modern native picker (PRD §5.3, C-API-24). */
import type { ElwoodAgentKind } from "../../activity/index.ts";
import { modelRow, rowPattern } from "../model-row.ts";
import type { PickerRow } from "../rows.ts";
import { blankOrRule, disclosureRow, foreignViewportRow, viewportMarker } from "./syntax.ts";
import type { ViewportItem } from "./types.ts";

export class ViewportBlock {
  readonly items: ViewportItem[] = [];
  readonly rows: PickerRow[] = [];
  cursorOptionIndex = -1;
  readonly tail: string[] = [];
  offset = 0;
  above = false;
  below = false;
  remainingBelow: number | undefined = 0;
  cursorItemIndex = -1;
  partial = false;
  nativePartial = false;
  private ended = false;
  private previousNumber: number | undefined;
  private readonly agent: ElwoodAgentKind;
  private readonly prefix: boolean;

  constructor(agent: ElwoodAgentKind, prefix: boolean) {
    this.agent = agent;
    this.prefix = prefix;
  }

  accept(line: string): boolean {
    if (blankOrRule.test(line)) {
      this.ended ||= this.items.length > 0;
      return true;
    }
    if (this.partial) return false;
    const marker = viewportMarker(line, this.agent);
    if (marker !== undefined) return this.acceptMarker(marker);
    const match = rowPattern.exec(line);
    const disclosure = this.agent === "claude" ? disclosureRow.exec(line) : null;
    if (match !== null || disclosure !== null) return this.acceptItem(line, match, disclosure);
    if (this.prefix && this.acceptPartial(line)) return true;
    if (this.items.length === 0) return !foreignViewportRow(line);
    this.ended = true;
    this.tail.push(line);
    return true;
  }

  private acceptPartial(line: string): boolean {
    if (this.ended) return false;
    if (/^\s*[❯›]\s*$/.test(line)) {
      this.partial = true;
      return true;
    }
    const model = /^\s*(?:❯|›)?\s*(\d+)(?:\.(?:\s.*)?)?$/.exec(line);
    const disclosure = /^\s*(?:❯|›)?\s*[▸▾]\s*(.*)$/.exec(line);
    const marker = /^\s*([↑↓])(?:\s+\d+(?:\s+(\S*))?)?\s*$/.exec(line);
    if (model !== null) {
      const number = Number(model[1]);
      if (!this.nextPartialModel(number)) return false;
    } else if (
      this.agent === "claude" &&
      disclosure !== null &&
      "More models".startsWith((disclosure[1] as string).trim())
    ) {
      this.nativePartial = true;
    } else if (marker !== null && "more".startsWith(marker[2] ?? "")) {
      if (marker[1] === "↑" ? this.items.length > 0 || this.above : this.items.length === 0)
        return false;
      this.nativePartial = true;
    } else return false;
    this.partial = true;
    return true;
  }

  private nextPartialModel(number: number): boolean {
    return (
      Number.isSafeInteger(number) &&
      number > 0 &&
      (this.previousNumber === undefined
        ? this.above || number === 1
        : number === this.previousNumber + 1)
    );
  }

  private acceptMarker(marker: {
    readonly direction: "↑" | "↓";
    readonly count: number | undefined;
  }): boolean {
    if (marker.direction === "↑") {
      if (this.items.length > 0 || this.above || this.ended) return false;
      this.above = true;
      this.offset = marker.count ?? 0;
    } else {
      if (this.items.length === 0 || this.below || this.ended) return false;
      this.below = true;
      this.remainingBelow = marker.count;
      this.ended = true;
    }
    return true;
  }

  private acceptItem(
    line: string,
    match: RegExpExecArray | null,
    disclosure: RegExpExecArray | null,
  ): boolean {
    if (this.ended) return false;
    const highlighted = match?.[1] ?? disclosure?.[1];
    if (highlighted) {
      if (this.cursorItemIndex >= 0) return false;
      this.cursorItemIndex = this.items.length;
    }
    if (match !== null) return this.acceptModel(line, match);
    if (this.items.some((item) => item.kind === "disclosure")) return false;
    this.items.push({ kind: "disclosure", expanded: disclosure?.[2] === "▾" });
    return true;
  }

  private acceptModel(line: string, match: RegExpExecArray): boolean {
    const number = Number(match[2]);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      (this.previousNumber !== undefined && number !== this.previousNumber + 1)
    )
      return false;
    const row = modelRow(match, line, this.agent);
    if (match[1]) this.cursorOptionIndex = this.rows.length;
    this.rows.push(row);
    this.previousNumber = number;
    this.items.push({ kind: "model", row });
    return true;
  }
}
