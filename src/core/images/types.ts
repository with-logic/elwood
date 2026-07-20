/**
 * Public types and limits for image attachments on message/prompt/guidance
 * submissions. Implements PRD §5.3 (C-API-44).
 */

// Single source of truth for supported byte formats: the type, the extension
// map, and the runtime membership check are all derived from this one table so a
// new format cannot be half-added (public union but rejected at runtime).
export const imageFormatExtension = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
} as const;

/** A supported in-memory image byte format. */
export type ImageFormat = keyof typeof imageFormatExtension;

/**
 * An image to attach, given EITHER as a filesystem path OR as in-memory bytes
 * with an explicit format — never both. The `never`-typed complementary fields
 * make the union exclusive, so a typed caller cannot pass a path alongside bytes
 * and slip an unvalidated field through (C-API-44).
 */
export type ImageInput =
  | { readonly path: string; readonly data?: never; readonly format?: never }
  | { readonly path?: never; readonly data: Uint8Array; readonly format: ImageFormat };

/** Optional per-submission options shared by sendPrompt/sendMessage/sendGuidance. */
export type SendOptions = {
  readonly images?: readonly ImageInput[];
};

/** Attachment limits enforced before any temp file is written (C-API-44). */
export const imageLimits = {
  maxCount: 16,
  maxBytesPerImage: 25 * 1024 * 1024,
  maxBytesTotal: 50 * 1024 * 1024,
} as const;
