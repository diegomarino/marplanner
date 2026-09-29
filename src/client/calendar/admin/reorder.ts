import { arrayMove } from "@dnd-kit/sortable";
import type { HighlightRule } from "../../../shared";

export function reorderRules(rules: HighlightRule[], activeId: string, overId: string) {
  const from = rules.findIndex((rule) => rule.id === activeId);
  const to = rules.findIndex((rule) => rule.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(rules, from, to).map((rule, priority) => ({ ...rule, priority }));
}
