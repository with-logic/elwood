/**
 * Shared pieces of the real-Codex configured-default e2e tests (PRD §5.3, C-API-23): naming a
 * configured default and the default a listing should report. Older Codex draws its own
 * `(default)` row marker; 0.164 draws only `(current)`, so Elwood names the default from
 * config.toml instead. A drawn marker outranks the config.
 */

import { readFileSync, writeFileSync } from "node:fs";

type ListedRow = { readonly id: string; readonly isDefault: boolean };

/**
 * Names `modelId` as the configured DEFAULT in `config.toml`; a running session's current model
 * is unaffected. Root keys precede every table, so the key goes first; Codex's boot-time
 * bookkeeping below it is kept.
 */
export function configureCodexDefaultModel(configPath: string, modelId: string): void {
  writeFileSync(configPath, `model = "${modelId}"\n${readFileSync(configPath, "utf8")}`);
}

/**
 * The default Codex drew itself, from a listing taken while config.toml names no model:
 * any default reported then is the CLI's own marker. Undefined on the markerless layout,
 * where the default follows the configured model.
 */
export function drawnCodexDefault(unconfigured: readonly ListedRow[]): string | undefined {
  const marked = defaultIds(unconfigured);
  if (marked.length > 1) throw new Error(`Codex drew ${marked.length} default rows.`);
  return marked[0];
}

export function defaultIds(models: readonly ListedRow[]): readonly string[] {
  return models.filter((model) => model.isDefault).map((model) => model.id);
}
