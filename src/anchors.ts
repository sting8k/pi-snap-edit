import { createHash } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function lineHash(line: string): string {
  const digest = createHash("sha256").update(line, "utf8").digest();
  const value = (digest[0]! << 17) | (digest[1]! << 9) | (digest[2]! << 1) | (digest[3]! >>> 7);
  let hash = "";
  for (let shift = 20; shift >= 0; shift -= 5) hash += BASE32[(value >>> shift) & 31]!;
  return hash;
}

export function formatHash(hash: string): string {
  return hash;
}

export function hashLines(lines: string[], _startLine: number, hiddenHashes: ReadonlySet<string> = new Set()): string {
  const hashes = lines.map((line) => formatHash(lineHash(line)));
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);

  return lines
    .map((line, i) => {
      const hash = hashes[i]!;
      return `${hiddenHashes.has(hash) || counts.get(hash) !== 1 ? "-----" : hash}|${line}`;
    })
    .join("\n");
}
