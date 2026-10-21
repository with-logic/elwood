/** Preserve shell invocation flags while pinning the final command in native proofs (PRD §12). */
export function prefixShellArgument(args: readonly string[], prefix: string): string[] {
  return args.map((arg, index) => index === args.length - 1 ? `${prefix}; ${arg}` : arg);
}
