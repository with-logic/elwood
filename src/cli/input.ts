/**
 * Incrementally composes positional and non-terminal stdin prompt input.
 * Implements PRD §12A.1 and C-CLI-04.
 */

import { CliValidationError, type PromptStdin } from "./types.ts";

export const maxPromptBytes = 8 * 1024 * 1024;

export async function readPromptInput(
  promptWords: readonly string[],
  stdin: PromptStdin,
): Promise<string> {
  const positional = promptWords.join(" ");
  let byteCount = Buffer.byteLength(positional);
  let separatorCounted = positional === "";
  assertWithinLimit(byteCount);
  const chunks: Buffer[] = [];
  if (stdin.isTTY !== true) {
    for await (const chunk of stdin.source) {
      const buffer = Buffer.from(chunk);
      byteCount += buffer.byteLength;
      if (!separatorCounted && buffer.byteLength > 0) {
        byteCount += 2;
        separatorCounted = true;
      }
      assertWithinLimit(byteCount);
      chunks.push(buffer);
    }
  }
  const piped = Buffer.concat(chunks).toString("utf8");
  const prompt =
    positional !== "" && piped !== "" ? `${positional}\n\n${piped}` : positional || piped;
  if (prompt.trim() === "") {
    throw new CliValidationError("invalid_arguments", "A non-empty prompt is required.");
  }
  return prompt;
}

function assertWithinLimit(bytes: number): void {
  if (bytes > maxPromptBytes) {
    throw new CliValidationError("invalid_arguments", "Prompt input exceeds the 8 MiB limit.");
  }
}
