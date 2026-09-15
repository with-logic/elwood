/**
 * Table and JSON rendering for `elwood models`.
 * Implements PRD §12A.10 and C-CLI-26.
 */

import type { AgentModelOption } from "../../core/models/rows.ts";
import { createCliSanitizer, formatDiagnosticValue } from "../output/sanitize.ts";
import type { AsyncOutputSink } from "../stream.ts";
import { renderTable } from "../table.ts";
import type { CliAgent, CliOutputMode } from "../types.ts";
import type { ExecuteModelsIo } from "./index.ts";
import type { ModelsResult } from "./result.ts";

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

/** Render a combined invocation once, after every started probe has been cleaned up. */
export async function renderCombinedModels(
  output: CliOutputMode,
  results: readonly ModelsResult[],
  io: ExecuteModelsIo,
): Promise<void> {
  const clean = createCliSanitizer();
  const agents = results.flatMap((result) =>
    "models" in result
      ? [
          {
            agent: result.agent,
            models: result.models.map((model) => sanitizedModel(model, clean)),
          },
        ]
      : [],
  );
  const errors = results.flatMap((result) => ("error" in result ? [result.error] : []));
  if (output === "json") {
    await io.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, type: "models", agents, errors })}\n`,
    );
    return;
  }
  await io.stdout.write(
    renderTable(
      ["AGENT", ...header],
      agents.flatMap(({ agent, models }) =>
        models.map((model) => [
          agent,
          model.isCurrent ? "*" : "",
          model.id,
          model.label,
          model.isDefault ? "(default)" : "",
          model.description ?? "",
        ]),
      ),
    ),
  );
  for (const error of errors)
    await io.stderr.write(
      `elwood: ${error.agent}: ${formatDiagnosticValue(error.error.message, clean)}\n`,
    );
}
