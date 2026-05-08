import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export type FileStatSnapshot = {
  fileHash: string;
  lineCount: number;
};

export function hashFileContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

export async function getFileStatSnapshot(absolutePath: string): Promise<FileStatSnapshot> {
  const content = await fs.readFile(absolutePath);
  const text = content.toString("utf8");
  const lineCount = text === "" ? 0 : text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
  return { fileHash: hashFileContent(content), lineCount };
}

export function formatFileStatSnapshot(snapshot: FileStatSnapshot): string {
  return `fileHash: ${snapshot.fileHash}`;
}
