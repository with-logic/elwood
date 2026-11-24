/** Read a native Claude prompt identity from hook or transcript metadata (PRD §5.4). */
export function claudePromptId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
