/** Isolate the Codex launch inspected by native response proofs (C-API-48, C-E2E-17). */
import { reportCodexHomeCommand } from "../../../src/codex/config/home.ts";
import { homeGuardScript, shellQuote } from "../../../src/runtime/shell.ts";
import { codexHomeReportPath } from "../../helpers/codex-home.ts";

/** Accept only the production home guard/report preamble before Codex's launch. */
export function parseResponseLaunchCommand(command: string | undefined) {
  const reportPath = codexHomeReportPath(command === undefined ? [] : [command]);
  if (reportPath === undefined || command === undefined)
    throw new Error("Unexpected native command");
  const prefix = `${homeGuardScript("session")}${reportCodexHomeCommand(reportPath)}; `;
  const launch = command.slice(prefix.length);
  if (!(command.startsWith(prefix) && launch.startsWith("exec codex ")))
    throw new Error("Unexpected native command");
  return { prefix, launch };
}

/** Preserve the validated preamble and pin the model inside the Codex exec command. */
export function pinResponseLaunchCommand(
  command: string | undefined,
  { resumed, model }: { readonly resumed: boolean; readonly model: string },
): string {
  const { prefix, launch } = parseResponseLaunchCommand(command);
  const modelArgument = `--model ${shellQuote(model)}`;
  const pinned = resumed ? `${launch} ${modelArgument}` : launch;
  if (!pinned.includes(modelArgument)) throw new Error("Missing pinned model");
  return `${prefix}${pinned}`;
}
