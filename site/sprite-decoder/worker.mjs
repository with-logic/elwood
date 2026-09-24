/** Decode sprite sheets away from the animation thread (PRD §13; site/docs/design/landing.md). */
const pending = new Map();

async function decode({ id, blob }) {
  if (typeof createImageBitmap !== "function") {
    globalThis.postMessage({ id, unsupported: true });
    return;
  }
  let image;
  try {
    image = await createImageBitmap(blob);
    // Browser bitmap decoding cannot be interrupted; cancellation still owns its result.
    if (!pending.has(id)) return;
    globalThis.postMessage({ id, image }, [image]);
    image = undefined;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (pending.has(id)) globalThis.postMessage({ id, error });
  } finally {
    image?.close();
  }
}

// Bound full-atlas decoding to one request at a time.
let tail = Promise.resolve();
globalThis.addEventListener("message", ({ data }) => {
  if (data.cancel !== undefined) {
    pending.delete(data.cancel);
    return;
  }
  const { id } = data;
  pending.set(id, data);
  const request = tail.then(async () => {
    const queued = pending.get(id);
    if (!queued) return;
    try {
      await decode(queued);
    } finally {
      pending.delete(id);
    }
  });
  tail = request.catch(() => {});
  return request;
});
