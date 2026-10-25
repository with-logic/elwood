/**
 * The received-output barrier of a test terminal that renders synchronously: everything it
 * receives is already on screen, so observing it waits for nothing (C-API-56).
 */
export const synchronousRender = {
  settled: (): Promise<void> => Promise.resolve(),
  renderFailed: false,
} as const;
