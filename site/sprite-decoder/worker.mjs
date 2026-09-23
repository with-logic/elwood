/** Decode sprite sheets away from the animation thread (PRD §13; site/docs/design/landing.md). */
async function decode({ id, blob }) {
  if (typeof createImageBitmap !== "function") {
    globalThis.postMessage({ id, unsupported: true });
    return;
  }
  let image;
  try {
    image = await createImageBitmap(blob);
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      if (context && typeof canvas.transferToImageBitmap === "function") {
        context.drawImage(image, 0, 0);
        const raster = canvas.transferToImageBitmap();
        image.close();
        image = raster;
      }
    }
    globalThis.postMessage({ id, image }, [image]);
    image = undefined;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    globalThis.postMessage({ id, error });
  } finally {
    image?.close();
  }
}

// Only one full atlas owns decoded pixels and rasterization buffers at a time.
let tail = Promise.resolve();
globalThis.addEventListener("message", ({ data }) => {
  const request = tail.then(() => decode(data));
  tail = request.catch(() => {});
  return request;
});
