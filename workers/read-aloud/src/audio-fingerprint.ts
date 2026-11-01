import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

// STAlign's common/ffmpeg.js invokes ffmpeg from PATH for splitting and probing.
export async function audioFingerprint(path: string, signal: AbortSignal): Promise<string> {
  // Same size-scaled limit as the server: about 10 MB/s, never under two minutes.
  const timeoutMs = Math.max(120_000, Math.ceil((await stat(path)).size / 10_000));
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a", "-c", "copy", "-f", "md5", "-"], {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
      if (output.length > 1024) child.kill();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const match = /^MD5=([a-fA-F0-9]{32})\s*$/.exec(output.trim());
      if (code !== 0 || !match) reject(new Error("Audio fingerprint failed"));
      else resolve(match[1].toLowerCase());
    });
  });
}
