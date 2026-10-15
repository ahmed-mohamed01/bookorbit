import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

/** Writes through a temporary file and a rename, so a crash leaves either the old or the new content. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(content);
      await syncIfAllowed(handle);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// Node's permission model, which the image runs under, refuses fsync; the rename still keeps the write atomic.
export async function syncIfAllowed(handle: { sync(): Promise<void> }): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw error;
  }
}
