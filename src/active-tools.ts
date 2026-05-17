export function preferQuickEditTools(activeTools: string[]): string[] {
  const withoutDisabledTools = activeTools.filter((toolName) => toolName !== "edit" && toolName !== "substitute_edit");
  return ["quick_edit", "target_edit"].reduce(
    (tools, toolName) => (tools.includes(toolName) ? tools : [...tools, toolName]),
    withoutDisabledTools,
  );
}
