import { describe, expect, it } from "vitest";

import { interpolate } from "@/i18n/interpolate";

describe("interpolate() — message placeholder filling", () => {
  it("fills each named placeholder", () => {
    expect(interpolate("Delete {name}?", { name: "School" })).toBe("Delete School?");
    expect(interpolate("{count} of {max}", { count: "2", max: "5" })).toBe("2 of 5");
  });

  it("inserts `$$` literally", () => {
    expect(interpolate("Delete {name}?", { name: "Budget $$" })).toBe("Delete Budget $$?");
  });

  it("inserts `$&`, `` $` `` and `$'` literally", () => {
    expect(interpolate("Delete {name}?", { name: "A $& B" })).toBe("Delete A $& B?");
    expect(interpolate("Delete {name}?", { name: "A $` B" })).toBe("Delete A $` B?");
    expect(interpolate("Delete {name}?", { name: "A $' B" })).toBe("Delete A $' B?");
  });

  it("inserts `$1` literally", () => {
    expect(interpolate("Delete {name}?", { name: "Top $1 list" })).toBe("Delete Top $1 list?");
  });

  it("does not fill a placeholder that arrives inside a value", () => {
    expect(
      interpolate("{name}'s briefing is paused on {date}", { name: "{date}", date: "2026-10-15" })
    ).toBe("{date}'s briefing is paused on 2026-10-15");
  });

  it("fills every occurrence of a repeated placeholder", () => {
    expect(interpolate("{name} and {name} again", { name: "Ben" })).toBe("Ben and Ben again");
  });

  it("leaves a placeholder without a value untouched", () => {
    expect(interpolate("hello {missing}", {})).toBe("hello {missing}");
    expect(interpolate("{toString} {name}", { name: "Ben" })).toBe("{toString} Ben");
  });

  it("accepts number values", () => {
    expect(interpolate("Row {position} of {total}", { position: 3, total: 0 })).toBe("Row 3 of 0");
  });
});
