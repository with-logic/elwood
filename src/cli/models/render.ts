/**
 * Table and JSON rendering for `elwood models`.
 * Implements PRD §12A.10 and C-CLI-24.
 */

import type { AgentModelOption } from "../../core/models/rows.ts";
import { createCliSanitizer } from "../output/sanitize.ts";
import type { AsyncOutputSink } from "../stream.ts";
import { renderTable } from "../table.ts";
import type { CliAgent, CliOutputMode } from "../types.ts";

const header = ["CURRENT", "ID", "LABEL", "DEFAULT", "DESCRIPTION"];

export async function renderModels(
  output: CliOutputMode,
  agent: CliAgent,
  models: readonly AgentModelOption[],
  stdout: AsyncOutputSink,
): Promise<void> {
  const clean = createCliSanitizer();
  const rows = models.map((model) => sanitizedModel(model, clean));
  if (output === "json") {
    const document = { schemaVersion: 1, type: "models", agent, models: rows };
    await stdout.write(`${JSON.stringify(document)}\n`);
    return;
  }
  await stdout.write(
    renderTable(
      header,
      rows.map((model) => [
        model.isCurrent ? "*" : "",
        model.id,
        model.label,
        model.isDefault ? "(default)" : "",
        model.description ?? "",
      ]),
    ),
  );
}

function sanitizedModel(
  model: AgentModelOption,
  clean: (value: string) => string,
): AgentModelOption {
  return {
    ...model,
    id: clean(model.id),
    label: clean(model.label),
    ...(model.description === undefined ? {} : { description: clean(model.description) }),
    raw: clean(model.raw),
  };
}
