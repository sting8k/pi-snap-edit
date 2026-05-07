import { hashLines } from "./anchors.js";

export function hashReadText(text: string, offsetInput: unknown): string {
  if (text.startsWith("Read image file ") || text.startsWith("[Line ")) return text;

  const noticeMatch = text.match(/\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\])$/);
  const body = noticeMatch ? text.slice(0, noticeMatch.index) : text;
  const notice = noticeMatch ? `\n\n${noticeMatch[1]}` : "";
  const startLine = typeof offsetInput === "number" && Number.isFinite(offsetInput) ? Math.max(1, Math.floor(offsetInput)) : 1;
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));

  return hashLines(lines, startLine) + notice;
}
