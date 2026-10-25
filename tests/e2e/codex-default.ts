/**
 * Shared pieces of the real-Codex configured-default e2e tests (PRD §5.3, C-API-23): a ready
 * session, naming a configured model, and the default a listing should report. Older Codex
 * draws its own `(default)` row marker; 0.164 draws only `(current)`, so Elwood names the
 * default from config.toml instead. A drawn marker outranks the config.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { cleanup, type E2eProject, waitFor } from "./helpers.ts";

type ListedRow = { readonly id: string; readonly isDefault: boolean };

// Codex fires SessionStart within seconds of launch; a minute without it is a failure.
const readyTimeoutMs = 60_000;

/** A read-only Codex session in `project`, ready for picker operations. */
export async function startReadyCodex(project: E2eProject): Promise<CodexSessionApi> {
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {},
  });
  try {
    await waitFor(
      () => (session.status === "ready" ? true : undefined),
      "codex ready",
      readyTimeoutMs,
    );
    return session;
  } catch (error) {
    await cleanup(session);
    throw error;
  }
}

/**
 * Names `model` as the configured default. Root keys precede every table, so the key goes
 * first; Codex's boot-time bookkeeping below it is kept.
 */
export function configureCodexModel(configPath: string, model: string): void {
  writeFileSync(configPath, `model = "${model}"\n${readFileSync(configPath, "utf8")}`);
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
