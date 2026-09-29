import { describe, it, expect } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("member-label (T012 — RED unit tests)", () => {
  useIsolatedDb();

  const createMember = (
    db: any,
    displayName: string,
    role: "parent" | "child",
    lifecycle: "active" | "archived"
  ) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, displayName, role, lifecycle, now, now);
    return id;
  };

  it("resolveMemberLabel(activeId) returns label with lifecycle active", async () => {
    const label = await import("../../src/server/modules/members/label");

    const db = getDb();
    const memberId = createMember(db, "Active Parent", "parent", "active");

    expect(label.resolveMemberLabel(memberId)).toStrictEqual({
      id: memberId,
      displayName: "Active Parent",
      lifecycle: "active",
      readOnly: false,
    });
  });

  it("resolveMemberLabel(archivedId) returns label with lifecycle archived and readOnly true", async () => {
    const label = await import("../../src/server/modules/members/label");

    const db = getDb();
    const memberId = createMember(db, "Archived Parent", "parent", "archived");

    expect(label.resolveMemberLabel(memberId)).toStrictEqual({
      id: memberId,
      displayName: "Archived Parent",
      lifecycle: "archived",
      readOnly: true,
    });
  });

  it("resolveMemberLabel(absentId) returns null", async () => {
    const label = await import("../../src/server/modules/members/label");

    expect(label.resolveMemberLabel("nonexistent-id")).toBeNull();
  });
});
