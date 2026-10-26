/**
 * An independent reading of Claude's own `/model` picker, its row count and the current
 * model's effort, for the real-CLI listing e2e (C-API-23, C-API-41), and a check that the
 * picker under test lists the served model catalog rather than Claude's compiled fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/core/predicates.ts";
import { type AgentModelOption, type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, type E2eProject, waitFor } from "./helpers.ts";

/**
 * Opens the picker with raw keys and reads the count it announces, its last rendered row's
 * absolute number plus the `… +K models` hidden below it, and the effort row, which shows
 * the current model's effort while the cursor opens on that model. Then cancels with
 * Escape. Raw keys and its own patterns keep it independent of the code it checks. A picker
 * Elwood did not open holds Elwood's own input until the composer is positively clear again,
 * so the session's next model call waits this one out.
 */
export async function readClaudePicker(
  session: ClaudeSessionApi,
): Promise<{ readonly rowCount: number; readonly effortRow: string | undefined }> {
  const screen = () => session.terminal.snapshot().text;
  const kept = () => screen().split("Kept model as").length;
  const before = kept();
  await session.sendKeys("/model");
  await waitFor(() => (/❯ \/model/.test(screen()) ? true : undefined), "/model typed", 10_000);
  await session.sendKeys("\r");
  let previous = "";
  const picker = await waitFor(() => {
    const text = screen();
    const settled = /Esc to cancel/.test(text) && text === previous;
    previous = text;
    return settled ? text.slice(text.lastIndexOf("Select model")) : undefined;
  }, "a settled claude model picker");
  await session.sendKeys("\u001b");
  await waitFor(() => (kept() > before ? true : undefined), "the picker to close", 10_000);
  const rows = [...picker.matchAll(/^\s*[❯↑↓]?\s*(\d+)\.\s/gm)].map((match) => Number(match[1]));
  const hidden = Number(/…\s*\+(\d+) models?/.exec(picker)?.[1] ?? 0);
  const effortRow = /^\s*[○◐●◉◈] .*$/m.exec(picker)?.[0].trim();
  return { rowCount: Math.max(...rows) + hidden, effortRow };
}

/** The picker's own row count for `project`'s account, read in a fresh session. */
export async function claudePickerRowCount(project: E2eProject): Promise<number> {
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({ ...project, autotrust: true, hooks: {} });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "claude ready", 60_000);
    return (await readClaudePicker(session)).rowCount;
  } finally {
    await cleanup(session);
  }
}

/**
 * The list is complete AND in picker order: each row carries its own position, so none is
 * missing or out of place, and the last hides nothing below it. A last row the cursor sits
 * on shows `❯` instead of `↓`, so this cannot see rows past it: pair it with a row count.
 */
export function hasCompletePickerOrder(models: readonly AgentModelOption[]): boolean {
  return (
    models.every((model, index) => new RegExp(`^[❯↑↓]?\\s*${index + 1}\\.\\s`).test(model.raw)) &&
    !models.at(-1)?.raw.startsWith("↓")
  );
}

/**
 * The default model saved in the user's Claude settings, which Enter or a number key in the
 * picker would overwrite and a listing must not (§4.5).
 */
export function savedClaudeModel(): unknown {
  const path = join(homedir(), ".claude", "settings.json");
  if (!existsSync(path)) return undefined;
  const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(settings)) throw new Error(`${path} does not hold a JSON object.`);
  return settings["model"];
}

/** The rows Claude 2.1.310 compiles in, listed when it does not adopt the served catalog. */
const compiledFallbackIds = "default,opus,fable,sonnet,haiku";

/**
 * Returns `models` unless they are Claude's compiled fallback picker, which has no hidden rows
 * to walk. Claude settles on it once per process, so the run fails with the likely cause
 * instead of retrying: a degraded environment stays visible.
 */
export function servedClaudeCatalog(
  models: readonly AgentModelOption[],
): readonly AgentModelOption[] {
  if (models.map((model) => model.id).join() !== compiledFallbackIds) return models;
  throw new Error(
    "Claude listed its compiled fallback picker (Default, Opus, Fable, Sonnet, Haiku), not " +
      "the served model catalog, so this run cannot test the catalog walk. Claude 2.1.310 " +
      "settles on the fallback for the whole process when CLAUDE_CODE_MODEL_CATALOG is off, " +
      "nonessential traffic is disabled, the provider is not first-party, its " +
      "tengu_delegated_quail flag is off, or ~/.claude/cache/model-catalog/ holds no catalog " +
      "and the first fetch takes longer than about 1.75 s (a loaded machine or slow network).",
  );
}
