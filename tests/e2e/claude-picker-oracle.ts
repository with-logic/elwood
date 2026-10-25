/**
 * An independent reading of Claude's own `/model` picker, its row count and the current
 * model's effort, for the real-CLI listing e2e (C-API-23, C-API-41).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModelOption, ClaudeSessionApi } from "../../src/index.ts";
import { waitFor } from "./helpers.ts";

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

/**
 * The list is complete AND in picker order: each row carries its own position, so none is
 * missing or out of place, and the last hides nothing below it.
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
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { model?: unknown }).model
    : undefined;
}
