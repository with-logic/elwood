/** Identify sprite asset failures without losing their original cause (PRD §13). */
export async function withSpriteAssetErrorContext(path, load) {
  try {
    return await load();
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    const detail = cause instanceof Error ? ` ${cause.message}` : "";
    throw new Error(`Couldn’t load ${path.slice(0, 200)}.${detail}`, { cause });
  }
}
