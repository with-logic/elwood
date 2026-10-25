/**
 * Reads a frame captured from a real CLI, stored under `tests/fixtures/<cli>-<version>/`.
 * Supports the model-picker recognition tests (C-API-23, C-API-24).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `capturedFrame("claude-2.1.310/model-picker/top-window")` reads that `.txt` capture. */
export function capturedFrame(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${path}.txt`, import.meta.url)), "utf8");
}
