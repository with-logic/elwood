/** Keep metadata gates distinct from worker sheet transfers (PRD §13). */
export function fetchSpriteMetadata(handler) {
  globalThis.fetch = (url, options) => new URL(url).pathname.endsWith(".webp")
    ? Promise.resolve(new Response(String(url))) : handler(url, options);
}
