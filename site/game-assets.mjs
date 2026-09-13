// A new query key escapes previously immutable cached URLs. Stable URLs now revalidate.
const ROOT = new URL("./assets/game/", import.meta.url);
export function gameAssetUrl(path) {
  const url = new URL(path, ROOT);
  url.searchParams.set("v", "revalidate-1");
  return url;
}
