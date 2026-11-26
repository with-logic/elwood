/**
 * Enriches Codex picker rows with configured defaults and cached speed capabilities.
 * Codex 0.164 marks only the `(current)` row and names no default on screen.
 * Implements PRD §5.3 `isDefault`, §5.11 speed evidence, and C-API-23.
 */

import { elwoodError, errnoCode } from "../../core/errors.ts";
import type { AgentModelOption } from "../../core/models/rows.ts";
import { withCodexConfigLock } from "./lock.ts";
import { readBoundedTextFile } from "./read.ts";
import { withCodexServiceTiers } from "./service-tiers.ts";
import { configuredCodexString } from "./toml-keys.ts";

/**
 * Marks the configured default once per listing, under the lock for the session's config. A
 * concurrent `setModel` on that file holds the lock while Codex's picker has written its selection
 * into config.toml, so the temporary selection is never read as the default. A deadline
 * or session close while waiting rejects without reading. `resolveConfigPath` resolves the
 * session's own config (C-CODEX-24), waiting for its launch report if need be. Cached speed
 * capabilities are added after releasing the config lock; that separate file needs no lock.
 */
export async function enrichCodexModels(
  options: readonly AgentModelOption[],
  signal: AbortSignal,
  resolveConfigPath: (signal: AbortSignal) => Promise<string>,
): Promise<readonly AgentModelOption[]> {
  // Resolved first: a report that cannot be read rejects without waiting for the lock.
  const path = await resolveConfigPath(signal);
  const mark = async () => markCodexDefault(options, configuredCodexModel(path));
  const marked = await withCodexConfigLock(path, mark, {
    signal,
    error: () => signal.reason,
  });
  return withCodexServiceTiers(marked, path);
}

/** A rendered `(default)` marker (older Codex) wins; otherwise the configured row is it. */
export function markCodexDefault(
  options: readonly AgentModelOption[],
  configuredModel: string | undefined,
): readonly AgentModelOption[] {
  if (options.some((option) => option.isDefault)) return options;
  const defaultId = configuredModel?.toLowerCase();
  return options.map((option) =>
    option.id === defaultId ? { ...option, isDefault: true } : option,
  );
}

/**
 * The model a plain `codex` launch with the config at `path` runs: the `model` of the profile
 * the root `profile` key selects, else the root `model` key. Undefined when the config names no
 * model and Codex falls back to its built-in default.
 */
export function configuredCodexModel(path: string): string | undefined {
  const text = readConfig(path);
  return text === undefined ? undefined : configuredCodexString(text, "model");
}

/** Only a missing file means "no config"; any other failure must not pass as one. */
function readConfig(path: string): string | undefined {
  try {
    return readBoundedTextFile(path);
  } catch (error) {
    throw elwoodError(
      "model_automation_failed",
      "Could not read the Codex config to find its default model.",
      { path, code: errnoCode(error) },
    );
  }
}
