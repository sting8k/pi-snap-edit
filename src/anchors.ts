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
  const linePart = lineText?.trim();
  const hashPart = hashText?.trim();
  if (!linePart || !hashPart || extra.length > 0 || !/^\d+$/.test(linePart) || !/^[0-9a-f]+$/i.test(hashPart)) return undefined;
  const line = Number.parseInt(linePart, 10);
  const hash = Number.parseInt(hashPart, 16);
  if (line < 1 || hash < 0) return undefined;
  return { line, hash };
}

export function invalidAnchorMessage(anchor: string): string {
  const prefix = anchor.split("|", 1)[0] ?? "";
  if (anchor.includes("|") && parseAnchor(prefix)) {
    return `invalid anchor '${anchor}'. Use only '${prefix}' before '|'.`;
  }
  return `invalid anchor '${anchor}'. Expected '<line>:<hash>', e.g. '11:f80'.`;
}
