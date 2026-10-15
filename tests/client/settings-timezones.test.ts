import { describe, expect, it } from "vitest";

import { timeZoneGroups } from "@/admin/timezones";

const values = (groups: ReturnType<typeof timeZoneGroups>) =>
  groups.flatMap((group) => group.options.map((option) => option.value));

describe("timeZoneGroups", () => {
  it("lists UTC first and the curated groups in order", () => {
    const groups = timeZoneGroups("Europe/Madrid");
    expect(groups.map((group) => group.id)).toEqual([
      "utc",
      "europe",
      "americas",
      "asiaPacific",
      "africaMiddleEast",
    ]);
    expect(groups[0]!.options).toEqual([{ value: "UTC", label: "UTC" }]);
  });

  it("gives curated zones a friendly label", () => {
    const europe = timeZoneGroups("UTC").find((group) => group.id === "europe")!;
    expect(europe.options).toContainEqual({
      value: "Europe/Madrid",
      label: "Madrid (CET/CEST)",
    });
  });

  it("has no duplicates and only zones the server accepts", () => {
    const all = values(timeZoneGroups("UTC"));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(38);
    for (const zone of all) {
      expect(() => new Intl.DateTimeFormat(undefined, { timeZone: zone })).not.toThrow();
    }
  });

  it("keeps a stored zone outside the list selectable, once, in a leading group", () => {
    const groups = timeZoneGroups("America/Argentina/Cordoba");
    expect(groups[0]).toEqual({
      id: "current",
      options: [{ value: "America/Argentina/Cordoba", label: "America/Argentina/Cordoba" }],
    });
    expect(values(groups).filter((zone) => zone === "America/Argentina/Cordoba")).toHaveLength(1);
  });

  it("does not add a current group for listed zones or UTC", () => {
    expect(timeZoneGroups("Asia/Tokyo")[0]!.id).toBe("utc");
    expect(timeZoneGroups("UTC")[0]!.id).toBe("utc");
  });

  it("replaces underscores in the label of an unlisted zone", () => {
    const [current] = timeZoneGroups("America/Port_of_Spain");
    expect(current!.options[0]!.label).toBe("America/Port of Spain");
  });
});
