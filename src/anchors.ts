export function lineHash(line: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(line, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xfff;
}

export function formatHash(hash: number): string {
  return hash.toString(16).padStart(3, "0");
}

export function hashLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i}:${formatHash(lineHash(line))}|${line}`).join("\n");
}

export function parseAnchor(anchor: string): { line: number; hash: number } | undefined {
  const [lineText, hashText, ...extra] = anchor.split(":");
  if (!lineText || !hashText || extra.length > 0) return undefined;
  const line = Number.parseInt(lineText.trim(), 10);
  const hash = Number.parseInt(hashText.trim(), 16);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(hash) || hash < 0) return undefined;
  return { line, hash };
}
