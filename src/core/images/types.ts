/**
 * Public types for image attachments on message/prompt/guidance submissions.
 * Implements PRD §5.3 (C-API-44).
 */

/** A supported in-memory image byte format. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/**
 * An image to attach to a submission, given either as a filesystem path or as
 * in-memory bytes with an explicit format. Order-agnostic attached content: an
 * image has no position within the message text (C-API-44).
 */
export type ImageInput =
  | { readonly path: string }
  | { readonly data: Uint8Array; readonly format: ImageFormat };

/** Optional per-submission options shared by sendPrompt/sendMessage/sendGuidance. */
export type SendOptions = {
  readonly images?: readonly ImageInput[];
};

/** File extension used when materializing bytes of each supported format. */
export const imageFormatExtension: Readonly<Record<ImageFormat, string>> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
};
