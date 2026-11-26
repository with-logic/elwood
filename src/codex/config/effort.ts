/**
 * Which reasoning effort a Codex launch's own `-c` arguments request in a form Elwood
 * recognizes. Readiness waits for Codex's status footer to show a label other than `default`
 * only for such a request (PRD §5.3, C-API-28).
 */

import {
  type CodexReasoningEffort,
  codexReasoningEfforts,
  knownReasoningEffort,
} from "../../core/reasoning-effort.ts";
import type { StartCodexOptions } from "../session/types.ts";

type EffortOptions = Pick<StartCodexOptions, "reasoningEffort" | "configOverrides">;

/** A root `model_reasoning_effort` entry, capturing the value text after its `=`. */
const reasoningEffortKey = /^\s*model_reasoning_effort\s*=(.*)$/s;
// Codex parses a `-c` value as TOML, else takes its raw text (`codex --help`). Codex 0.172
// applied `"low"`, `'low'`, `"""low"""`, `'''low'''` and `"low" # note` as `low`, and a bare
// `low`, with or without spaces around the `=`, as its raw text (docs/cli-behavior.md).
const tomlString = /^\s*(?:"""([^"]*)"""|'''([^']*)'''|"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/s;
const rawWord = /^\s*([\w-]+)\s*$/;

/** The text a `-c` value sets, in the spellings above, else undefined. */
function overrideText(value: string): string | undefined {
  const quoted = tomlString.exec(value);
  if (quoted) return quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4];
  return rawWord.exec(value)?.[1];
}

/** The value text of the last root `model_reasoning_effort` entry, which Codex applies. */
function lastRootEffortValue(options: EffortOptions): string | undefined {
  return (options.configOverrides ?? [])
    .map((override) => reasoningEffortKey.exec(override)?.[1])
    .findLast((value) => value !== undefined);
}

/**
 * The recognized effort a launch's `-c` arguments request. Codex applies them in order, so the
 * last root `model_reasoning_effort` entry in `configOverrides` decides, and `reasoningEffort`
 * wins over them all because `buildCodexShellCommand` passes it after them. The result is
 * undefined when that entry's value is in a spelling Elwood does not read, such as a basic
 * string with escapes, or names an effort Codex does not know (Codex launches with one and
 * fails at the first turn). Codex still receives that entry unchanged; readiness just has no
 * effort to wait for. A profile's key, `profiles.<name>.model_reasoning_effort`, does not
 * count: Codex 0.172 ignores it, even with `--profile <name>` selecting that profile.
 */
export function requestedCodexEffort(options: EffortOptions): CodexReasoningEffort | undefined {
  if (options.reasoningEffort !== undefined) return options.reasoningEffort;
  const last = lastRootEffortValue(options);
  return knownReasoningEffort(
    last === undefined ? undefined : overrideText(last),
    codexReasoningEfforts,
  );
}

/** Whether the deciding `configOverrides` entry sets an effort Elwood does not recognize. */
export function hasUnrecognizedDecidingCodexEffortOverride(options: EffortOptions): boolean {
  return (
    options.reasoningEffort === undefined &&
    lastRootEffortValue(options) !== undefined &&
    requestedCodexEffort(options) === undefined
  );
}
