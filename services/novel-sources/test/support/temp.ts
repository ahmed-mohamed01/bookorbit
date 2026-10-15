import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

export const makeTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "novel-sources-"));
  directories.push(directory);
  return directory;
};

export const removeTempDirs = async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
};
