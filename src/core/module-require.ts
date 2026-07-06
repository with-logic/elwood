/**
 * CJS-bundler-safe createRequire construction.
 * Bundlers that lower this library to CJS (Electron main bundles, rollup)
 * rewrite import.meta.url to undefined but provide the CJS __filename, so
 * callers pass import.meta.url and this falls back when it was lowered away.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

declare const __filename: string;

export function moduleRequire(metaUrl: string | undefined): NodeJS.Require {
  if (metaUrl !== undefined) return createRequire(metaUrl);
  return createRequire(pathToFileURL(__filename).href);
}
