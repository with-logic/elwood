/**
 * Resolves one CLI setting together with concise, user-facing provenance.
 * Implements PRD §12A.4 and C-CLI-14/C-CLI-19/C-CLI-20.
 */

export type SourcedValue<T> = { readonly value: T | undefined; readonly source: string };

export function layered<T>(
  flag: SourcedValue<T>,
  environment: SourcedValue<T>,
  config: SourcedValue<T>,
  fallback: SourcedValue<T>,
): SourcedValue<T> {
  if (flag.value !== undefined) return flag;
  if (environment.value !== undefined) return environment;
  if (config.value !== undefined) return config;
  return fallback;
}

export function sourced<T>(value: T | undefined, source: string): SourcedValue<T> {
  return { value, source };
}

export function booleanFlag(
  value: boolean | undefined,
  positive: string,
  negative: string,
): SourcedValue<boolean> {
  return sourced(value, value === false ? negative : positive);
}

export function configKey(path: string, key: string): string {
  return `${path}#${key}`;
}
