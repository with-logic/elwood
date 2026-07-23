/**
 * Barrel for shared, adapter-neutral image-attachment support (PRD §5.3,
 * C-API-44/45/46). Codex/macOS clipboard mechanics live under `src/codex/`.
 */

export {
  type AttachTerminal,
  type ChipWaitOptions,
  imageChipCount,
  waitForImageChip,
} from "./chip-wait.ts";
export { type MaterializedImages, materializeImages } from "./materialize.ts";
export {
  type ImageSnapshot,
  resolvePaths,
  snapshotImages,
  validateImages,
} from "./resolve.ts";
export type { ImageFormat, ImageInput, SendOptions } from "./types.ts";
