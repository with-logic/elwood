/**
 * Declarative screen-fact tables: adapter-owned, versioned pattern rules
 * evaluated against rendered terminal text or the OSC window title, with
 * matched-rule explain data.
 * Implements PRD §5.3 rendered-state detection (C-TURN-01 through C-TURN-05).
 */

import type { ElwoodAgentKind } from "./activity/index.ts";

export type ScreenFactKind =
  | "composer_visible"
  | "working_visible"
  | "interrupt_complete_visible"
  | "blocking_prompt_visible";

/** Which rendered source a rule's patterns match against. */
export type ScreenFactRegion = "screen" | "title";

/**
 * A rule matches EITHER via `all` (every regex tests true against the region's
 * text) OR via `match` (a predicate over the region's text). `match` exists for
 * rules whose recognition is not a plain regex-over-the-whole-frame test — most
 * importantly the trust-prompt blocking rules, which must anchor on non-option
 * lines so an option-only trust phrase cannot spoof a blocking prompt (PRD §5.1).
 * A raw header regex applied to the full frame would misclassify such an option.
 */
export type ScreenFactRuleCondition =
  | { readonly all: readonly RegExp[]; readonly match?: never }
  | { readonly all?: never; readonly match: (text: string) => boolean };

export type ScreenFactRule = {
  /** Stable id surfaced in diagnostics and explain traces. */
  readonly id: string;
  readonly fact: ScreenFactKind;
  /** Where the patterns are evaluated; defaults to the viewport text. */
  readonly region?: ScreenFactRegion;
  /** Evaluated only while no earlier rule has set this fact, so a specific rule keeps its label. */
  readonly fallback?: true;
} & ScreenFactRuleCondition;

export type ScreenFactTable = {
  readonly agent: ElwoodAgentKind;
  /** CLI version these rules were last verified against by the e2e suites. */
  readonly verifiedAgainst: string;
  readonly rules: readonly ScreenFactRule[];
  /** Adapter fallback hidden while trust owns a partial repaint. */
  readonly trustOwnedFallback?: string;
};

export type ScreenFacts = Readonly<Record<ScreenFactKind, boolean>>;

export type MatchedScreenRule = {
  readonly id: string;
  readonly fact: ScreenFactKind;
  readonly region: ScreenFactRegion;
};

export type ScreenFactReading = {
  readonly facts: ScreenFacts;
  /** The rules that matched, for explain traces. */
  readonly matched: readonly MatchedScreenRule[];
};

export type RenderedFrame = {
  readonly text: string;
  /** The OSC window title, "" when none has been set. */
  readonly title: string;
};

/** A rule fires when its `all` regexes all match, or its `match` predicate holds. */
function ruleMatches(rule: ScreenFactRule, target: string): boolean {
  return rule.all === undefined
    ? rule.match(target)
    : rule.all.every((pattern) => pattern.test(target));
}

/**
 * Evaluates the full table against a frame: sets every fact whose rules match
 * (a fact is true if any of its rules match) and returns the list of matched
 * rules — with their fact and region — for explain-trace diagnostics. A caller may
 * suppress one fallback by id without copying the immutable table.
 */
export function readScreenFacts(
  table: ScreenFactTable,
  frame: RenderedFrame,
  suppressedRule?: string,
): ScreenFactReading {
  const facts: Record<ScreenFactKind, boolean> = {
    composer_visible: false,
    working_visible: false,
    interrupt_complete_visible: false,
    blocking_prompt_visible: false,
  };
  const matched: MatchedScreenRule[] = [];
  for (const rule of table.rules) {
    if (rule.id === suppressedRule) continue;
    const region = rule.region ?? "screen";
    const target = region === "title" ? frame.title : frame.text;
    if ((rule.fallback && facts[rule.fact]) || !ruleMatches(rule, target)) continue;
    facts[rule.fact] = true;
    matched.push({ id: rule.id, fact: rule.fact, region });
  }
  return { facts, matched };
}
