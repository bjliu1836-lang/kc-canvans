import { describe, expect, it } from "vitest";
import {
  buildLayoutBatch,
  calibrateLayoutDraft,
  LayoutDraftValidationError,
  validateLayoutDraftCandidate,
} from "./layoutDraft";

const source = { sourceId: "image_1", fileName: "room.png" };

function candidate() {
  return {
    scale: { mode: "estimated", confidence: 0.4 },
    components: [{
      id: "wall_01",
      name: "后墙",
      category: "wall",
      primitive: "box",
      position: [0, 0, -3],
      size: [6, 2.8, 0.15],
      rotationYDegrees: 0,
      confidence: 0.82,
      uncertain: false,
    }],
  };
}

describe("layout draft validation", () => {
  it("accepts constrained JSON and builds deterministic bottom-anchored primitives", () => {
    const draft = validateLayoutDraftCandidate(candidate(), source, { draftId: "draft_fixed", createdAt: "2026-10-10T00:00:00.000Z" });
    const built = buildLayoutBatch(draft, "layout_fixed", ["layout_fixed_wall_01"]);

    expect(draft.components).toHaveLength(1);
    expect(built.batch.objectIds).toEqual(["layout_fixed_wall_01_2"]);
    expect(built.objects[0]).toMatchObject({
      kind: "prop",
      geometryType: "box",
      transform: { position: [0, 0, -3], scale: [6, 2.8, 0.15] },
      layoutSource: { batchId: "layout_fixed", category: "wall" },
    });
  });

  it.each([
    ["negative size", { size: [-1, 2, 3] }],
    ["NaN position", { position: [0, Number.NaN, 0] }],
    ["unknown category", { category: "lamp" }],
    ["unknown asset", { primitive: "glb" }],
  ])("rejects %s", (_label, patch) => {
    const value = candidate();
    value.components[0] = { ...value.components[0], ...patch } as typeof value.components[0];
    expect(() => validateLayoutDraftCandidate(value, source)).toThrow(LayoutDraftValidationError);
  });

  it("rejects more than 30 components", () => {
    const value = candidate();
    value.components = Array.from({ length: 31 }, (_, index) => ({
      ...value.components[0],
      id: `wall_${index}`,
    }));
    expect(() => validateLayoutDraftCandidate(value, source)).toThrow("组件数量超过 30 个上限");
  });

  it("calibrates only the draft from a known width", () => {
    const draft = validateLayoutDraftCandidate(candidate(), source, { draftId: "draft_fixed" });
    const calibrated = calibrateLayoutDraft(draft, "wall_01", 3);

    expect(calibrated.scale).toMatchObject({ mode: "anchored", anchorWidthMeters: 3 });
    expect(calibrated.components[0].size).toEqual([3, 1.4, 0.075]);
    expect(draft.components[0].size).toEqual([6, 2.8, 0.15]);
  });

  it("calibrates from the height axis when the anchor dimension is height", () => {
    const draft = validateLayoutDraftCandidate(candidate(), source, { draftId: "draft_fixed" });
    const calibrated = calibrateLayoutDraft(draft, "wall_01", 1.4, "height");

    expect(calibrated.scale).toMatchObject({
      mode: "anchored",
      anchorWidthMeters: 1.4,
      anchorDimension: "height",
    });
    expect(calibrated.components[0].size).toEqual([3, 1.4, 0.075]);
    expect(calibrated.components[0].position).toEqual([0, 0, -1.5]);
  });

  it("splits a wall around a detected door so the generated passage remains open", () => {
    const value = candidate();
    value.components.push({
      ...value.components[0],
      id: "door_01",
      name: "门",
      category: "door",
      position: [0, 0, -3],
      size: [1, 2.1, 0.12],
    });
    const draft = validateLayoutDraftCandidate(value, source);

    expect(draft.components.map((component) => component.id)).toEqual([
      "wall_01_left",
      "wall_01_right",
      "wall_01_top",
      "door_01",
    ]);
    expect(draft.components.filter((component) => component.category === "wall").every((wall) => (
      wall.position[0] + wall.size[0] / 2 <= -0.5
      || wall.position[0] - wall.size[0] / 2 >= 0.5
      || wall.position[1] >= 2.1
    ))).toBe(true);
  });

  it("places a generated ground box below the scene floor without changing other component coordinates", () => {
    const value = candidate();
    value.components[0] = {
      ...value.components[0],
      id: "ground_01",
      name: "地面",
      category: "ground",
      position: [0, 0, 0],
      size: [6, 0.1, 6],
    };
    const draft = validateLayoutDraftCandidate(value, source);
    const built = buildLayoutBatch(draft, "layout_ground", [], 1.5);

    expect(built.objects[0].transform.position).toEqual([0, 1.4, 0]);
    expect(built.objects[0].transform.position[1] + built.objects[0].transform.scale[1]).toBeCloseTo(1.5);
  });
});
