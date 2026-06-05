import { deflateRawSync, inflateRawSync } from "node:zlib";

const MAX_CURSOR_CHARS = 10000;
const MAX_CURSOR_BYTES = 200000;

export function encodeCursor(payload: Record<string, unknown>): string {
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8"));
  return `z1.${compressed.toString("base64url")}`;
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string): T {
  try {
    if (cursor.length > MAX_CURSOR_CHARS) {
      throw new Error("Cursor is too large.");
    }
    if (cursor.startsWith("z1.")) {
      const inflated = inflateRawSync(Buffer.from(cursor.slice(3), "base64url"));
      if (inflated.byteLength > MAX_CURSOR_BYTES) {
        throw new Error("Cursor payload is too large.");
      }
      return JSON.parse(inflated.toString("utf8")) as T;
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.byteLength > MAX_CURSOR_BYTES) {
      throw new Error("Cursor payload is too large.");
    }
    return JSON.parse(decoded.toString("utf8")) as T;
  } catch {
    throw new Error("Invalid cursor.");
  }
}
