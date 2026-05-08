export function hashReadText(text: string, fileHash: string): string {
  if (text.startsWith("Read image file ")) return text;
  return `fileHash: ${fileHash}\n\n${text}`;
}
