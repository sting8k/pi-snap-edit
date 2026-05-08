function numberReadLines(text: string): string {
  const continuationIndex = text.lastIndexOf("\n\n[");
  const hasContinuation = continuationIndex >= 0 && text.endsWith("]");
  const body = hasContinuation ? text.slice(0, continuationIndex) : text;
  const suffix = hasContinuation ? text.slice(continuationIndex) : "";

  const numbered = body
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");

  return `${numbered}${suffix}`;
}

export function hashReadText(text: string, fileHash: string): string {
  if (text.startsWith("Read image file ")) return text;
  return `fileHash: ${fileHash}\n\n${numberReadLines(text)}`;
}
