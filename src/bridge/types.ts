/**
 * Shared hook bridge process result types.
 * Implements PRD §6 and §7A.
 */

export type BridgeProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
