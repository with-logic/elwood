/**
 * Formats safe, single-line human diagnostics for headless CLI output.
 * Implements PRD §12A.3 and C-CLI-10/C-CLI-12.
 */

import type { CliProgressRecord, CliTerminalRecord } from "../output/types.ts";

type DiagnosticValue = (value: string) => string;

export function debugLine(record: CliProgressRecord, value: DiagnosticValue): string {
  switch (record.type) {
    case "text":
      return `[assistant] ${value(record.text)}\n`;
    case "thinking":
      return `[thinking] ${value(record.text)}\n`;
    case "tool": {
      const name = value(record.name ?? "unknown");
      const content = record.content === undefined ? "" : ` ${value(record.content)}`;
      return `[tool ${record.phase}] ${name}${content}\n`;
    }
    case "status":
      return `[status] ${record.status}\n`;
    case "warning":
      return `[warning ${value(record.code)}] ${value(record.message)}\n`;
  }
}

export function conciseLine(record: CliProgressRecord, value: DiagnosticValue): string | undefined {
  if (record.type === "tool" && record.phase === "call") return `Tool: ${value(record.name)}\n`;
  if (record.type === "warning") return `Warning ${value(record.code)}: ${value(record.message)}\n`;
  return undefined;
}

export function warningLine(
  record: Extract<CliProgressRecord, { readonly type: "warning" }>,
  value: DiagnosticValue,
): string {
  return `elwood: warning [${value(record.code)}]: ${value(record.message)}\n`;
}

export function completionLine(record: CliTerminalRecord, value: DiagnosticValue): string {
  const outcome = record.type === "result" ? "Completed" : `Failed (${value(record.error.code)})`;
  if (record.cleanup.status === "failed") return `${outcome}; cleanup failed\n`;
  if (record.cleanup.action === "preserve") return `${outcome}; session preserved\n`;
  if (record.cleanup.action === "teardown") return `${outcome}; session removed\n`;
  return `${outcome}; no session cleanup needed\n`;
}
