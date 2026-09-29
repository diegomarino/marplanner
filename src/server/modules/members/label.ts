import { getDb } from "../../db/client";

export function resolveMemberLabel(id: string): {
  id: string;
  displayName: string;
  lifecycle: "active" | "archived";
  readOnly: boolean;
} | null {
  const db = getDb();
  const row = db.prepare("SELECT id, display_name, lifecycle FROM members WHERE id = ?").get(id) as
    { id: string; display_name: string; lifecycle: string } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    displayName: row.display_name,
    lifecycle: row.lifecycle as "active" | "archived",
    readOnly: row.lifecycle === "archived",
  };
}
