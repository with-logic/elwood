/** Decode sprite sheets away from the animation thread (PRD §13; site/docs/design/landing.md). */
async function decode({ id, blob }) {
  if (typeof createImageBitmap !== "function") {
    globalThis.postMessage({ id, unsupported: true });
    return;
  }
  let image;
  try {
    image = await createImageBitmap(blob);
    globalThis.postMessage({ id, image }, [image]);
    image = undefined;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    globalThis.postMessage({ id, error });
  } finally {
    image?.close();
  }
}

// Bound full-atlas decoding to one request at a time.
let tail = Promise.resolve();
globalThis.addEventListener("message", ({ data }) => {
  const request = tail.then(() => decode(data));
  tail = request.catch(() => {});
  return request;
});
