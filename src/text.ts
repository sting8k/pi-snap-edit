export type BomSplit = {
  bom: boolean;
  text: string;
};

export function splitBom(content: string): BomSplit {
  return content.startsWith("\uFEFF")
    ? { bom: true, text: content.slice(1) }
    : { bom: false, text: content };
}

export function joinBom(text: string, bom: boolean): string {
  return bom ? `\uFEFF${text}` : text;
}

export function splitLines(content: string): string[] {
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
  if (withoutTrailingNewline.length === 0) return [];
  return withoutTrailingNewline.split(/\r?\n/);
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}
