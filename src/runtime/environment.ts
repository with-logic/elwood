/** Snapshot launch-only child environments without changing the host (PRD §5.1, §5.5). */
import { createHash } from "node:crypto";

export type ChildEnvironment = Readonly<Record<string, string | undefined>>;

export function snapshotEnvironment<T extends { readonly env?: ChildEnvironment }>(
  options: T,
): Omit<T, "env"> & { readonly env: ChildEnvironment } {
  const env = { ...process.env, ...options.env };
  for (const name of Object.keys(env)) {
    if (env[name] === undefined) delete env[name];
  }
  return { ...options, env };
}

export function environmentCacheKey(env: ChildEnvironment | undefined): string {
  if (env === undefined) return "";
  const entries = Object.keys(env)
    .sort()
    .map((name) => [name, env[name]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
