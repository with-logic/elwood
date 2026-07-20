/**
 * Barrel for image-attachment support (PRD §5.3, C-API-44/45/46).
 */

export {
  clipboardImageSupported,
  restoreClipboardText,
  setClipboardImage,
  snapshotClipboardText,
} from "./clipboard.ts";
export { type ResolvedImages, resolveImages } from "./resolve.ts";
export type { ImageFormat, ImageInput, SendOptions } from "./types.ts";
export { imageFormatExtension } from "./types.ts";
