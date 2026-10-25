/**
 * Reads a frame captured from a real CLI, stored under `tests/fixtures/<cli>-<version>/`.
 * Supports the recognition tests that read real captures (C-API-23, C-API-24, C-API-28, C-E2E-09).
 */
import { readFileSync } from "node:fs";

/** `capturedFrame("codex-0.164.0/model-picker/picker")` reads that `.txt` capture. */
export function capturedFrame(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}.txt`, import.meta.url), "utf8");
}
