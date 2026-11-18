/** Optional property projection for native events and CLI requests (PRD §5.4, §12A). */
export function optional<K extends string, V>(
  value: V | undefined,
  key: K,
): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V });
}
