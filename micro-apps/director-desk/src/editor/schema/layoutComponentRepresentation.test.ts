import { describe, expect, it } from "vitest";
import type { LayoutDraft, LayoutDraftComponent } from "./layoutDraft";
import {
  getLayoutCatalogUnitBoxTransform,
  LAYOUT_CATALOG_FIT_MODE,
  resolveLayoutComponentRepresentation,
} from "./layoutComponentRepresentation";

function component(overrides: Partial<LayoutDraftComponent> = {}): LayoutDraftComponent {
  return {
    id: "sofa_1",
    name: "沙发",
    category: "sofa",
    primitive: "box",
    position: [1, 0, -2],
    size: [2.4, 0.9, 1.1],
    rotationYDegrees: 90,
    confidence: 0.95,
    uncertain: false,
    visible: true,
    ...overrides,
  };
}

function draft(components: LayoutDraftComponent[]): LayoutDraft {
  return {
    version: 1,
    id: "draft_catalog_fit",
    sourceId: "source_1",
    sourceFileName: "room.png",
    createdAt: "2026-10-20T00:00:00.000Z",
    scale: { mode: "estimated", confidence: 0.8 },
    components,
    characters: [],
  };
}

describe("layout catalog representation", () => {
  it("resolves a simple sofa once and supplies the local-forward correction", () => {
    const sofa = component();
    expect(resolveLayoutComponentRepresentation(draft([sofa]), sofa)).toMatchObject({
      kind: "catalog",
      item: { fileName: "0027_short-couch.fbx" },
      yawCorrectionRadians: 0,
    });
    expect(LAYOUT_CATALOG_FIT_MODE).toBe("unit-box-bottom-center-v1");
  });

  it("keeps explicit assemblies, linked parts, and parents with children on program geometry", () => {
    const sofa = component();
    const assembled = component({ assembly: [{ primitive: "box", position: [0, 0.5, 0], size: [1, 1, 1] }] });
    expect(resolveLayoutComponentRepresentation(draft([assembled]), assembled)).toEqual({ kind: "geometry" });
    const linked = component({ partOfComponentId: "parent" });
    expect(resolveLayoutComponentRepresentation(draft([linked]), linked)).toEqual({ kind: "geometry" });
    const child = component({ id: "sofa_pillow", name: "靠垫", category: "prop", partOfComponentId: sofa.id });
    expect(resolveLayoutComponentRepresentation(draft([sofa, child]), sofa)).toEqual({ kind: "geometry" });
  });

  it("accepts a simple rectangular footprint and rejects compound footprints", () => {
    const rectangular = component({ groundFootprint: [{ confidence: 0.8, outer: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]] }] });
    expect(resolveLayoutComponentRepresentation(draft([rectangular]), rectangular).kind).toBe("catalog");
    const compound = component({ groundFootprint: [
      { confidence: 0.8, outer: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]] },
      { confidence: 0.8, outer: [[1.1, -0.5], [1.4, -0.5], [1.4, 0.5], [1.1, 0.5]] },
    ] });
    expect(resolveLayoutComponentRepresentation(draft([compound]), compound)).toEqual({ kind: "geometry" });
  });

  it("only maps a dining table and a simple sofa to matching local catalog models", () => {
    const diningTable = component({ id: "table", name: "餐桌", category: "table" });
    expect(resolveLayoutComponentRepresentation(draft([diningTable]), diningTable)).toMatchObject({
      kind: "catalog",
      item: { fileName: "0136_dining-table.fbx" },
    });
    const desk = component({ id: "desk", name: "书桌", category: "table" });
    expect(resolveLayoutComponentRepresentation(draft([desk]), desk)).toEqual({ kind: "geometry" });
    const sectional = component({ name: "转角组合沙发" });
    expect(resolveLayoutComponentRepresentation(draft([sectional]), sectional)).toEqual({ kind: "geometry" });
  });

  it("fits catalog canonical bounds to a unit bottom-center box", () => {
    const fit = getLayoutCatalogUnitBoxTransform("sofa_modern_low.fbx");
    expect(fit).not.toBeNull();
    expect(fit?.position[1]).toBeCloseTo(0);
    expect(fit?.scale[0]).toBeCloseTo(1 / 1.94);
    expect(getLayoutCatalogUnitBoxTransform("unknown.fbx")).toBeNull();
  });
});
