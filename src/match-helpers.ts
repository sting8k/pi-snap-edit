export type ExpectedStartLineMatch = "exact" | "trim";

/** Unescape literal sequences models often send in JSON tool args (OC EscapeNormalized). */
export function unescapeLiteralSequences(value: string): string {
  return value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
    switch (capturedChar) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      case "$":
        return "$";
      default:
        return match;
    }
  });
}

function compareCore(actual: string, expected: string, mode: ExpectedStartLineMatch): boolean {
  const compare = mode === "trim"
    ? (left: string, right: string) => left.trim() === right.trim()
    : (left: string, right: string) => left === right;

  if (compare(actual, expected)) return true;
  const unescaped = unescapeLiteralSequences(expected);
  if (unescaped !== expected && compare(actual, unescaped)) return true;
  return false;
}

export function lineContentMatches(actual: string, expected: string, mode: ExpectedStartLineMatch): boolean {
  return compareCore(actual, expected, mode);
}

export function matchingLineNumbers(
  lines: string[],
  expectedStartLine: string,
  mode: ExpectedStartLineMatch,
): number[] {
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineContentMatches(lines[i]!, expectedStartLine, mode)) matches.push(i + 1);
  }
  return matches;
}

export function escapeMismatchHint(actual: string, expected: string, mode: ExpectedStartLineMatch): string | undefined {
  const unescaped = unescapeLiteralSequences(expected);
  if (unescaped === expected) return undefined;
  if (lineContentMatches(actual, expected, mode)) return undefined;
  if (!compareCore(actual, unescaped, mode)) return undefined;
  return "hint: expectedStartLine uses escape sequences (e.g. \\n, \\t); the file matches after unescaping.";
}

export function trimMismatchHint(mode: ExpectedStartLineMatch): string {
  return mode === "exact"
    ? 'hint: use expectedStartLineMatch="trim" if indentation or trailing whitespace differs.'
    : "";
}

export function formatFailureMessage(headline: string, sections: Array<string | undefined>): string {
  return [headline, ...sections.filter((section): section is string => Boolean(section))].join("\n");
}