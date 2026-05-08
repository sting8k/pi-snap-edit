export type HashReadTextOptions = {
  startLine?: number;
  totalLineCount?: number;
};

const CONTINUATION_NOTICE = /\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\])$/;

function numberReadLines(text: string, options: HashReadTextOptions = {}): string {
  const noticeMatch = text.match(CONTINUATION_NOTICE);
  const body = noticeMatch ? text.slice(0, noticeMatch.index) : text;
  const nextOffset = noticeMatch ? Number(noticeMatch[1]!.match(/Use offset=(\d+) to continue\./)?.[1]) : undefined;
  const hasRealContinuation = nextOffset === undefined || options.totalLineCount === undefined || nextOffset <= options.totalLineCount;
  const suffix = noticeMatch && hasRealContinuation ? `\n\n${noticeMatch[1]!}` : "";
  const startLine = Number.isInteger(options.startLine) && options.startLine! > 0 ? options.startLine! : 1;
  const bodyLines = body === "" ? [] : body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
  const endLine = startLine + bodyLines.length - 1;
  const maxLine = Math.max(endLine, options.totalLineCount ?? 0);
  const width = String(maxLine).length;

  const numbered = bodyLines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")}| ${line}`)
    .join("\n");

  return numbered ? `${numbered}${suffix}` : suffix.trimStart();
}

export function hashReadText(text: string, fileHash: string, options: HashReadTextOptions = {}): string {
  if (text.startsWith("Read image file ")) return text;
  return `fileHash: ${fileHash}\n\n${numberReadLines(text, options)}`;
}
