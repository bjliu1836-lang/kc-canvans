import { describe, expect, it } from "vitest";
import {
  buildLayoutBatch,
  validateLayoutDraftCandidate,
} from "../../micro-apps/director-desk/src/editor/schema/layoutDraft";

const source = { sourceId: "image_1", fileName: "图1.jpg" };

function component(
  id: string,
  name: string,
  category: "ground" | "wall" | "window" | "sofa" | "cabinet",
  position: [number, number, number],
  size: [number, number, number],
  rotationYDegrees: number,
) {
  return {
    id,
    name,
    category,
    primitive: "box" as const,
    position,
    size,
    rotationYDegrees,
    confidence: 0.8,
    uncertain: false,
  };
}

describe("reference layout spatial chain", () => {
  it("preserves model coordinates and only converts degrees to radians", () => {
    const raw = {
      scale: { mode: "estimated", confidence: 0.4 },
      components: [
        component("ground_01", "地面", "ground", [0, 0, 0], [6, 0.1, 7], 0),
        component("back_wall", "后墙", "wall", [0, 0, -3.5], [6, 2.8, 0.12], 0),
        component("window_01", "后窗", "window", [0, 0.8, -3.42], [3.2, 1.8, 0.08], 0),
        component("bed_as_sofa", "床", "sofa", [1.35, 0, -0.3], [1.6, 0.55, 2.1], 90),
        component("bookcase_01", "左书柜", "cabinet", [-2.75, 0, -1.7], [0.35, 2.2, 1.1], 180),
      ],
      characters: [],
    };

    const draft = validateLayoutDraftCandidate(raw, source, {
      draftId: "draft_spatial_verify",
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    const { objects } = buildLayoutBatch(draft, "layout_spatial_verify", []);

    expect(draft.components.map(({ id, position, size, rotationYDegrees }) => ({
      id,
      position,
      size,
      rotationYDegrees,
    }))).toEqual(raw.components.map(({ id, position, size, rotationYDegrees }) => ({
      id,
      position,
      size,
      rotationYDegrees,
    })));

    expect(objects.find((item) => item.layoutSource?.componentId === "bed_as_sofa")?.transform)
      .toMatchObject({
        position: [1.35, 0, -0.3],
        scale: [1.6, 0.55, 2.1],
        rotation: [0, Math.PI / 2, 0],
      });
    expect(objects.find((item) => item.layoutSource?.componentId === "bookcase_01")?.transform.rotation[1])
      .toBeCloseTo(Math.PI);
  });

  it("accepts a spatially wrong but structurally valid bed direction", () => {
    const raw = {
      scale: { mode: "estimated", confidence: 0.4 },
      components: [
        component("ground_01", "地面", "ground", [0, 0, 0], [6, 0.1, 7], 0),
        component("bed_as_sofa", "床", "sofa", [0.1, 0, -2], [1.6, 0.55, 2.1], 0),
      ],
      characters: [],
    };

    const draft = validateLayoutDraftCandidate(raw, source);
    const { objects } = buildLayoutBatch(draft, "layout_wrong_but_valid", []);
    const bed = objects.find((item) => item.layoutSource?.componentId === "bed_as_sofa");

    expect(draft.components.find((item) => item.id === "bed_as_sofa")?.rotationYDegrees).toBe(0);
    expect(bed?.transform.rotation[1]).toBe(0);
    expect(bed?.transform.scale).toEqual([1.6, 0.55, 2.1]);
  });
});
