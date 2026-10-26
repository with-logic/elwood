/**
 * Reads a frame captured from a real CLI, stored under `tests/fixtures/<cli>-<version>/`.
 * Supports the recognition and model-picker window-walk tests that read real captures
 * (C-API-23, C-API-24, C-API-28, C-E2E-09).
 */
import { readFileSync } from "node:fs";

/** `capturedFrame("codex-0.164.0/model-picker/picker")` reads that `.txt` capture. */
export function capturedFrame(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}.txt`, import.meta.url), "utf8");
}

const walkKeys = { "↓": "\u001b[B", "↑": "\u001b[A" } as const;
type WalkMarker = keyof typeof walkKeys;
/** The arrow keys a captured walk is made of. */
export type WalkKey = (typeof walkKeys)[WalkMarker];

/** One arrow key and the screen the real CLI painted after it. */
export type CapturedStep = { readonly key: WalkKey; readonly frame: string };

export type CapturedWalk = {
  readonly opening: string;
  readonly steps: readonly CapturedStep[];
};

const isWalkMarker = (marker: string): marker is WalkMarker => Object.hasOwn(walkKeys, marker);

/**
 * A captured key-by-key walk: the opening frame, then each key and the frame after it,
 * stored as frames separated by `--- ↓` / `--- ↑` lines.
 */
export function capturedWalk(path: string): CapturedWalk {
  return parseWalk(capturedFrame(path));
}

/** Splits a captured walk; a separator naming no key fails here, not as a stalled replay. */
export function parseWalk(text: string): CapturedWalk {
  const [opening = "", ...rest] = text.split(/^--- /m);
  const steps = rest.map((block) => {
    const newline = block.indexOf("\n");
    const marker = block.slice(0, newline);
    if (!isWalkMarker(marker)) throw new Error(`Unknown walk marker "${marker}".`);
    return { key: walkKeys[marker], frame: block.slice(newline + 1) };
  });
  return { opening, steps };
}
