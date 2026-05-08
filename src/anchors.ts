import { createHash } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HASH_PATTERN = "[A-Z2-7]{5}";

export type Anchor = {
  hash: string;
};

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

export function hashLines(lines: string[], _startLine: number): string {
  const hashes = lines.map((line) => formatHash(lineHash(line)));
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);

  return lines
    .map((line, i) => `${counts.get(hashes[i]!) === 1 ? hashes[i] : "-----"}|${line}`)
    .join("\n");
}

export function parseAnchor(anchor: string): Anchor | undefined {
  const text = anchor.trim();
  const hashOnly = new RegExp(`^${HASH_PATTERN}$`, "i");
  return hashOnly.test(text) ? { hash: text.toUpperCase() } : undefined;
}

export function invalidAnchorMessage(anchor: string): string {
  const prefix = anchor.split("|", 1)[0] ?? "";
  if (anchor.includes("|") && parseAnchor(prefix)) {
    return `invalid anchor '${anchor}'. Use only '${prefix}' before '|'.`;
  }
  return `invalid anchor '${anchor}'. Expected '<hash>', e.g. 'ABCDE'.`;
}
