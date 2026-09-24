/** Validate native capture metadata before replaying it in terminal regressions. */
import { readFileSync } from "node:fs";

export function readNativeInputFrame(path: URL) {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native frame must be an object");
  const fields = value as Record<string, unknown>;
  const text = stringField(fields, "text");
  const title = stringField(fields, "title");
  const cols = integerField(fields, "cols");
  const rows = integerField(fields, "rows");
  const cursorX = integerField(fields, "cursorX");
  const cursorY = integerField(fields, "cursorY");
  const baseY = integerField(fields, "baseY");
  const viewportY = integerField(fields, "viewportY");
  const visible = fields["visible"];
  if (typeof visible !== "boolean") throw new Error("Native frame visibility must be boolean");
  if (!(cols > cursorX && rows > cursorY && baseY >= viewportY))
    throw new Error("Native frame coordinates must fit the terminal");
  return { text, title, cols, rows, cursorX, cursorY, baseY, viewportY, visible };
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new Error(`Native frame ${key} must be a string`);
  return value;
}

function integerField(fields: Record<string, unknown>, key: string): number {
  const value = fields[key];
  if (!(typeof value === "number" && Number.isInteger(value) && value >= 0))
    throw new Error(`Native frame ${key} must be a nonnegative integer`);
  return value;
}
