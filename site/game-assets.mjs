/** URLs and paths of the shipped game assets, shared by every loader (PRD §13 and §13.5). */

// A new query key escapes previously immutable cached URLs. Stable URLs now revalidate.
const ROOT = new URL("./assets/game/", import.meta.url);
export function gameAssetUrl(path) {
  const url = new URL(path, ROOT);
  url.searchParams.set("v", "revalidate-1");
  return url;
}

/** Where a clip's metadata and sheets live. The bank and the download-ahead pass must agree,
 * or a download warms a URL that is never used.
 */
export const clipMetadataPath = (name) => `${name}/clip.json`;
export const clipPagePath = (name, page) => `${name}/${page.file}`;
