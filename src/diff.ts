
export const CONTEXT_LINES = 5;

export type EditDiff = {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

export type ContextRange = {
  startIndex: number;
  endIndex: number;
};

export function formatContexts(lines: string[], ranges: ContextRange[]): string {
  const ordered = ranges
    .filter((range) => range.startIndex < range.endIndex)
    .sort((a, b) => a.startIndex - b.startIndex);
  const merged: ContextRange[] = [];

  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
    } else {
      merged.push({ ...range });
    }
  }

  const width = String(lines.length).length;
  return merged
    .map((range) => lines
      .slice(range.startIndex, range.endIndex)
      .map((line, index) => `${String(range.startIndex + index + 1).padStart(width, " ")}| ${line}`)
      .join("\n"),
    )
    .join("\n---\n");
}


export function formatDiffs(diffs: EditDiff[]): string {
  if (diffs.length === 0) return "";
  const chunks: string[] = ["── diff ──"];

  for (const diff of diffs) {
    const oldEnd = diff.oldStart + Math.max(0, diff.oldLines.length - 1);
    if (diff.oldLines.length <= 1 && diff.newLines.length <= 1) {
      chunks.push(`:${diff.oldStart}`);
    } else {
      const newEnd = diff.newStart + Math.max(0, diff.newLines.length - 1);
      chunks.push(`:${diff.oldStart}-${Math.max(oldEnd, newEnd)}`);
    }


    for (let i = 0; i < diff.oldLines.length; i++) {
      const line = diff.oldLines[i]!;
      chunks.push(`- ${line}`);
    }
    for (let i = 0; i < diff.newLines.length; i++) {
      const line = diff.newLines[i]!;
      chunks.push(`+ ${line}`);
    }
    chunks.push("");
  }

  return chunks.join("\n").trimEnd();
}
