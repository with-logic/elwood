/** Read actual adapter materializations before attachment cleanup (C-API-44/56). */
import { readFileSync } from "node:fs";

export const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function attachedImage(value: string | Uint8Array, clipboardPath: string | undefined) {
  const path =
    value === "\u0016"
      ? clipboardPath
      : String(value)
          .slice(6, -6)
          .match(/^(.+elwood-image-.+\.png)$/)?.[1];
  return path ? { path, bytes: readFileSync(path) } : undefined;
}
