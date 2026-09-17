/** Private facade-owned image copies shared with submission (PRD §5.3/§5.8, C-API-44). */
import { QueuedImageBudget } from "./queued-budget.ts";
import { type ImageSnapshot, snapshotImages } from "./resolve.ts";
import type { ImageInput, SendOptions } from "./types.ts";

// Only copies made here are registered. Callers cannot brand mutable input as safe.
const owned = new WeakMap<readonly ImageInput[], ImageSnapshot>();
const noRelease = () => undefined;

export function capturedImageSnapshot(images: readonly ImageInput[]): ImageSnapshot | undefined {
  return owned.get(images);
}

export class ImageCaptures {
  private readonly budget: QueuedImageBudget;
  constructor(maxQueuedBytes?: number) {
    this.budget = new QueuedImageBudget(maxQueuedBytes);
  }

  capture<T extends SendOptions>(
    options: T | undefined,
  ): {
    readonly options: T | undefined;
    readonly release: () => void;
  } {
    if (options?.images === undefined) {
      return { options: options === undefined ? undefined : { ...options }, release: noRelease };
    }
    const snapshot = snapshotImages(options.images);
    this.budget.reserve(snapshot.inlineByteTotal);
    owned.set(snapshot.images, snapshot);
    return {
      options: { ...options, images: snapshot.images },
      release: () => {
        owned.delete(snapshot.images);
        this.budget.release(snapshot.inlineByteTotal);
      },
    };
  }
}
