export function preferQuickEditTools(activeTools: string[]): string[] {
  const withoutEdit = activeTools.filter((toolName) => toolName !== "edit");
  return ["file_stat", "quick_edit", "substitute_edit"].reduce(
    (tools, toolName) => (tools.includes(toolName) ? tools : [...tools, toolName]),
    withoutEdit,
  );
}
