import { describe, it, expect } from "vitest";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("member-referential (RED by design, turns green)", () => {
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

  it("isActiveMember(activeId) returns true for an active member", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    const memberId = createMember(db, "Active Parent", "parent", "active");

    expect(referential.isActiveMember(memberId)).toBe(true);
  });

  it("isActiveMember(archivedId) returns false for an archived member", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    const memberId = createMember(db, "Archived Parent", "parent", "archived");

    expect(referential.isActiveMember(memberId)).toBe(false);
  });

  it("isActiveMember(nonexistentId) returns false for a non-existent id", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    createMember(db, "Active Child", "child", "active");

    expect(referential.isActiveMember("nonexistent-id")).toBe(false);
  });

  it("listActiveMembers() excludes archived members", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    const activeId = createMember(db, "Active Parent", "parent", "active");
    createMember(db, "Archived Parent", "parent", "archived");

    const activeMembers = referential.listActiveMembers();
    expect(activeMembers.some((m: any) => m.id === activeId)).toBe(true);
    expect(activeMembers.length).toBe(1);
  });

  it("listActiveChildren() returns only active children", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    createMember(db, "Active Child", "child", "active");
    createMember(db, "Archived Child", "child", "archived");
    createMember(db, "Active Parent", "parent", "active");

    const activeChildren = referential.listActiveChildren();
    expect(activeChildren.length).toBe(1);
    expect(activeChildren[0].role).toBe("child");
  });

  it("assertActiveMember(activeId) does not throw", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    const memberId = createMember(db, "Active Member", "parent", "active");

    expect(() => referential.assertActiveMember(memberId)).not.toThrow();
  });

  it("assertActiveMember(archivedId) throws MemberReferenceError", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    const memberId = createMember(db, "Archived Member", "parent", "archived");

    expect(() => referential.assertActiveMember(memberId)).toThrow(
      referential.MemberReferenceError
    );
  });

  it("assertActiveMember(nonexistentId) throws MemberReferenceError", async () => {
    const referential = await import("../../src/server/modules/members/referential");

    const db = getDb();
    createMember(db, "Active Member", "parent", "active");

    expect(() => referential.assertActiveMember("nonexistent-id")).toThrow(
      referential.MemberReferenceError
    );
  });
});
