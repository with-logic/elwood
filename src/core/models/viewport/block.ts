/** The contiguous selectable block inside a modern native picker (PRD §5.3, C-API-24). */
import { modelRow, rowPattern } from "../model-row.ts";
import type { PickerRow } from "../rows.ts";
import { blankOrRule, foreignViewportRow, viewportMarker } from "./syntax.ts";
import type { ViewportGrammar, ViewportItem } from "./types.ts";

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
  private readonly grammar: ViewportGrammar;
  private readonly prefix: boolean;

  constructor(grammar: ViewportGrammar, prefix: boolean) {
    this.grammar = grammar;
    this.prefix = prefix;
  }

  accept(line: string): boolean {
    if (blankOrRule.test(line)) {
      this.ended ||= this.items.length > 0;
      return true;
    }
    if (this.partial) return false;
    const marker = viewportMarker(line, this.grammar);
    if (marker !== undefined) return this.acceptMarker(marker);
    const match = rowPattern.exec(line);
    const disclosure = this.grammar.disclosure?.row.exec(line) ?? null;
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
    const marker = this.grammar.partialMarker.exec(line);
    if (model !== null) {
      const number = Number(model[1]);
      if (!this.nextPartialModel(number)) return false;
    } else if (this.isDisclosurePrefix(line)) {
      this.nativePartial = true;
    } else if (marker !== null && this.grammar.markerSuffix.startsWith(marker[2] ?? "")) {
      if (marker[1] === "↑" ? this.items.length > 0 || this.above : this.items.length === 0)
        return false;
      this.nativePartial = true;
    } else return false;
    this.partial = true;
    return true;
  }

  private isDisclosurePrefix(line: string): boolean {
    const disclosure = this.grammar.disclosure;
    if (disclosure === undefined) return false;
    const match = disclosure.partial.exec(line);
    return match !== null && disclosure.label.startsWith((match[1] as string).trim());
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
    const row = modelRow(match, line, this.grammar.agent, this.grammar.selector);
    if (match[1]) this.cursorOptionIndex = this.rows.length;
    this.rows.push(row);
    this.previousNumber = number;
    this.items.push({ kind: "model", row });
    return true;
  }
}
