export type QuickEditRenderSummary = {
  additions: number;
  removals: number;
  hasDiff: boolean;
};

export function summarizeQuickEditOutput(text: string): QuickEditRenderSummary {
  let inDiff = false;
  let additions = 0;
  let removals = 0;

  for (const line of text.split("\n")) {
    if (line === "── diff ──") {
      inDiff = true;
      continue;
    }
    if (inDiff && line === "") continue;
    if (inDiff && line === "---") break;
    if (!inDiff) continue;

    if (line.startsWith("+ ")) additions++;
    else if (line.startsWith("- ")) removals++;
  }

  return { additions, removals, hasDiff: additions > 0 || removals > 0 };
}

export type QuickEditTheme = {
  fg?: (role: any, text: string) => string;
  bold?: (text: string) => string;
};

export function color(theme: QuickEditTheme, role: string, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(role, text) : text;
}

function renderAnchoredLine(theme: QuickEditTheme, marker: string, line: string, role: string): string | undefined {
  const match = line.match(/^(\d+):([0-9a-f]{3})\|(.*)$/);
  if (!match) return undefined;
  const [, lineNo, hash, content] = match;
  const gutter = `${marker} ${lineNo}:${hash} │ `;
  return `${color(theme, "muted", gutter)}${color(theme, role, content ?? "")}`;
}

function renderQuickEditLine(theme: QuickEditTheme, line: string): string {
  if (line === "── diff ──") return color(theme, "muted", "diff");
  if (line === "---") return color(theme, "muted", "---");
  if (/^:\d+(?:-\d+)?$/.test(line)) return color(theme, "muted", line);

  if (line.startsWith("+ ")) {
    return renderAnchoredLine(theme, "+", line.slice(2), "success") ?? color(theme, "success", line);
  }
  if (line.startsWith("- ")) {
    return renderAnchoredLine(theme, "-", line.slice(2), "error") ?? color(theme, "error", line);
  }

  return renderAnchoredLine(theme, " ", line, "toolOutput") ?? color(theme, "toolOutput", line);
}

export function renderQuickEditOutput(theme: QuickEditTheme, text: string): string {
  return text.split("\n").map((line) => renderQuickEditLine(theme, line)).join("\n");
}
