import { open } from "node:fs/promises";

/** Read at most limit + 1 bytes, even when a subprocess creates a larger file. */
export async function readBoundedUtf8(path: string, limit: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error("Codex reply too large");
    return bytes.toString("utf8", 0, length);
  } finally {
    await file.close();
  }
}
