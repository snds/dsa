import { describe, expect, it } from "vitest";
import { canonicalComponent, catalogComponentNames, componentFamilies, familyOf, patternCatalog } from "../src/data/index.js";

describe("framework 09 data", () => {
  it("ships the 62-component family map and the 7-pattern catalog", () => {
    expect(catalogComponentNames()).toHaveLength(62);
    expect(componentFamilies().families).toHaveLength(9);
    expect(patternCatalog().patterns.map((p) => p.id)).toEqual(["form", "master-detail", "dashboard", "wizard", "async-triad", "confirmation", "filtering"]);
    for (const p of patternCatalog().patterns) {
      for (const c of p.components) expect(catalogComponentNames(), `${p.id}: ${c}`).toContain(c);
    }
  });

  it("maps names to canonical components and families", () => {
    expect(canonicalComponent("AlertDialog")).toBe("Alert Dialog");
    expect(canonicalComponent("DialogContent")).toBe("Dialog");
    expect(canonicalComponent("Dialog.Title")).toBe("Dialog");
    expect(canonicalComponent("PrimaryButton")).toBe("Button");
    expect(canonicalComponent("Drawer")).toBe("Sheet");
    expect(canonicalComponent("Frobnicator")).toBeUndefined();
    expect(familyOf("Chip")).toBe("Data Display");
    expect(familyOf("CardHeader")).toBe("Layout");
    expect(familyOf("Toolbar")).toBe("Action");
  });
});
