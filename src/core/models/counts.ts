/** Only positive, exactly represented native model counts may drive navigation (C-API-24). */
export function positiveCount(text: string | undefined): number | undefined {
  const count = Number(text);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}
