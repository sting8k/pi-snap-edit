import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export type FileStatSnapshot = {
  fileHash: string;
};

export function hashFileContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

export async function getFileStatSnapshot(absolutePath: string): Promise<FileStatSnapshot> {
  const content = await fs.readFile(absolutePath);
  return { fileHash: hashFileContent(content) };
}

export function formatFileStatSnapshot(snapshot: FileStatSnapshot): string {
  return `fileHash: ${snapshot.fileHash}`;
}
