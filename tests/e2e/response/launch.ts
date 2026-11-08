/** Isolate the Codex launch inspected by native response proofs (C-API-48, C-E2E-17). */
import { reportCodexHomeCommand } from "../../../src/codex/config/home.ts";
import { homeGuardScript } from "../../../src/runtime/shell.ts";

/** Accept only the production home guard/report preamble before Codex's launch. */
export function responseLaunch(command: string | undefined) {
  const reportPath = command?.match(/ > '(\/[^'\n]+\/codex-home-[^/'\n]+)' \|\| exit 73; /)?.[1];
  if (command === undefined || reportPath === undefined)
    throw new Error("Unexpected native command");
  const prefix = `${homeGuardScript("session")}${reportCodexHomeCommand(reportPath)}; `;
  const launch = command.slice(prefix.length);
  if (!(command.startsWith(prefix) && launch.startsWith("exec codex ")))
    throw new Error("Unexpected native command");
  return { prefix, launch };
}
