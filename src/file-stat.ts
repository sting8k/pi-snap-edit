import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export type FileStatSnapshot = {
  path: string;
  size: number;
  mtimeMs: number;
  fileHash: string;
};

export function hashFileContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 10);
}

export async function getFileStatSnapshot(absolutePath: string): Promise<FileStatSnapshot> {
  const [stat, content] = await Promise.all([fs.stat(absolutePath), fs.readFile(absolutePath)]);
  return {
    path: absolutePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fileHash: hashFileContent(content),
  };
}

export function formatFileStatSnapshot(snapshot: FileStatSnapshot): string {
  return [
    `path: ${snapshot.path}`,
    `size: ${snapshot.size}`,
    `mtimeMs: ${snapshot.mtimeMs}`,
    `fileHash: ${snapshot.fileHash}`,
  ].join("\n");
}
