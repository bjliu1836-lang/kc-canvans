import { describe, expect, it } from "vitest";
import { createLayoutCharacterRenderAdapter, getLayoutComponentRotationYDegrees, validateLayoutDraftCandidate } from "./layoutDraft";
import { cameraFitBreakdown, cameraFitError, carryFittedParentMotion, fitReferenceCamera, fitReferenceScene, imageObservationToLayoutDraft, ImageObservationValidationError, type CameraFitPair } from "./imageObservationLayout";
import type { LayoutDraftComponent } from "./layoutDraft";

const source = { sourceId: "observation_fixture", fileName: "reference.png" };

function projectedBox(component: LayoutDraftComponent, camera: { position: [number, number, number]; target: [number, number, number]; fov: number }, aspect: number) {
  const yaw = component.rotationYDegrees * Math.PI / 180;
  const focal = 0.5 / Math.tan(camera.fov * Math.PI / 360);
  const values = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => {
    const x = component.position[0] + Math.cos(yaw) * sx * component.size[0] / 2 + Math.sin(yaw) * sz * component.size[2] / 2;
    const y = component.position[1] + (sy + 1) * component.size[1] / 2;
    const z = component.position[2] - Math.sin(yaw) * sx * component.size[0] / 2 + Math.cos(yaw) * sz * component.size[2] / 2;
    const depth = camera.position[2] - z;
    return [0.5 + x * focal / aspect / depth, 0.5 - (y - camera.position[1]) * focal / depth] as const;
  })));
  return [Math.min(...values.map(([x]) => x)), Math.min(...values.map(([, y]) => y)), Math.max(...values.map(([x]) => x)), Math.max(...values.map(([, y]) => y))] as [number, number, number, number];
}

function bedObservation(side: "image_left" | "image_right") {
  const isRight = side === "image_right";
  return {
    spaceType: "enclosed",
    imageAspectRatio: 1.5,
    surfaces: [{
      id: "anchor_wall", kind: "wall", side,
      bbox: isRight ? [0.78, 0.2, 1, 0.64] : [0, 0.2, 0.22, 0.64], confidence: 0.95,
    }],
    items: [
      {
        id: "bed", name: "床体", semanticType: "bed", bbox: isRight ? [0.22, 0.39, 0.92, 0.66] : [0.08, 0.39, 0.78, 0.66],
        confidence: 0.98, visibility: "visible", mainColor: "#F5F0E6", againstSurfaceId: "anchor_wall",
      },
      {
        id: "headboard", name: "床头板", category: "cabinet", bbox: isRight ? [0.78, 0.4, 0.92, 0.52] : [0.08, 0.4, 0.22, 0.52],
        confidence: 0.9, visibility: "visible", mainColor: "#F0EBE0", partOfId: "bed",
      },
    ],
  };
}

describe("imageObservationToLayoutDraft", () => {
  it("accepts an exact bounded camera candidate and falls back when evidence is sparse", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const components: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `object_${index}`, name: "fixture object", category: "prop", primitive: "box",
      position: [x, 0, 0], size: [2, 1, 1], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = components.map((component) => ({ component, confidence: 0.95, bbox: projectedBox(component, camera, 1) }));
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceCamera(pairs, fallback, 1, components);
    expect(fit.rejectionReason).toBeNull();
    expect(fit.camera?.confidence).toBeGreaterThan(0);
    expect(fit.best).toBeLessThan(fit.before!);
    expect(cameraFitError(pairs, fit.camera!, 1)).toBeCloseTo(fit.best!, 8);
    const sparse = fitReferenceCamera(pairs.slice(0, 2), fallback, 1, components);
    expect(sparse.camera).toBe(fallback);
    expect(sparse.rejectionReason).toBe("insufficient-evidence");
  });

  it("maps upright, column and flat forms with aspect-aware dimensions", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        { id: "column", name: "柱体", semanticType: "pillar", bbox: [0.19, 0, 0.25, 0.72], confidence: 0.9, visibility: "visible" },
        { id: "upright", name: "竖立物件", category: "prop", semanticType: "statue", bbox: [0.66, 0.02, 0.84, 0.42], confidence: 0.9, visibility: "visible" },
        { id: "flat", name: "软垫", semanticType: "cushion", bbox: [0.21, 0.78, 0.51, 0.98], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const column = draft.components.find((component) => component.id === "column")!;
    const upright = draft.components.find((component) => component.id === "upright")!;
    const flat = draft.components.find((component) => component.id === "flat")!;
    expect(column.size[0]).toBe(column.size[2]);
    expect(column.size[1]).toBeGreaterThan(column.size[0] * 3);
    expect(upright.size[1]).toBeGreaterThan(1);
    expect(upright.size[1]).toBeGreaterThan(upright.size[2]);
    expect(flat.size[1]).toBe(0.08);
  });

  it("keeps upright depth independent from bbox height and stable under small bbox-width changes", () => {
    const widths = [0.18, 0.19, 0.2, 0.21];
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        ...widths.map((right, index) => ({
          id: `buddha_${index}`,
          name: "佛像",
          semanticType: "buddha_statue",
          bbox: [0.5, 0.02, 0.5 + right, 0.42],
          confidence: 0.9,
          visibility: "visible",
        })),
        { id: "wide_vase", name: "花瓶", semanticType: "ceramic_vase", bbox: [0.1, 0.1, 0.44, 0.5], confidence: 0.9, visibility: "visible" },
        { id: "wide_lamp", name: "灯具", semanticType: "unknown_lamp_form", bbox: [0.5, 0.1, 0.9, 0.5], confidence: 0.9, visibility: "visible" },
        { id: "wide_unknown_a", name: "未知陈设甲", semanticType: "unknown_display", bbox: [0.05, 0.3, 0.65, 0.7], confidence: 0.8, visibility: "visible" },
        { id: "wide_unknown_b", name: "未知陈设乙", semanticType: "unclassified_prop", bbox: [0.3, 0.12, 0.88, 0.52], confidence: 0.8, visibility: "visible" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    const buddhas = widths.map((_, index) => byId.get(`buddha_${index}`)!);
    for (const statue of buddhas) {
      expect(statue.size[1]).toBeCloseTo(1.2);
      expect(statue.size[1]).toBeGreaterThan(statue.size[2]);
      expect(statue.size[2]).toBeLessThanOrEqual(1.2);
    }
    buddhas.forEach((statue, index) => expect(statue.size[0]).toBeCloseTo([0.96, 1.0133333333, 1.0666666667, 1.12][index]));
    expect(buddhas.map((statue) => statue.size[2])).toEqual([0.3, 0.3, 0.3, 0.3]);
    for (const id of ["wide_vase", "wide_lamp", "wide_unknown_a", "wide_unknown_b"]) {
      const item = byId.get(id)!;
      expect(item.size[1]).toBeCloseTo(id === "wide_vase" ? 0.55 : 2.4);
      expect(item.size[2]).toBeLessThanOrEqual(1.2);
      expect(item.size[1]).toBeGreaterThan(item.size[2]);
    }

    const landscape = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9, surfaces: [],
      items: [{ id: "landscape", name: "statue", semanticType: "statue", bbox: [0.4, 0.2, 0.6, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source).components[0];
    const portrait = imageObservationToLayoutDraft({
      imageAspectRatio: 9 / 16, surfaces: [],
      items: [{ id: "portrait", name: "statue", semanticType: "statue", bbox: [0.18, 0.2, 0.8122222222, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source).components[0];
    expect(portrait.size[0]).toBeCloseTo(landscape.size[0]);
    expect(portrait.size[1]).toBeCloseTo(landscape.size[1]);
    expect(portrait.size[2]).toBeCloseTo(landscape.size[2]);
  });

  it("keeps blankets, throws and tablecloths as supported flat textiles", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed", imageAspectRatio: 1,
      surfaces: [],
      items: [
        { id: "bed", name: "床", semanticType: "bed", bbox: [0.2, 0.25, 0.8, 0.75], confidence: 0.95, visibility: "visible" },
        { id: "throw_blanket", name: "毯子", semanticType: "throw_blanket", bbox: [0.3, 0.42, 0.55, 0.64], confidence: 0.9, visibility: "visible", supportId: "bed" },
        { id: "tablecloth", name: "桌布", semanticType: "tablecloth", bbox: [0.6, 0.42, 0.75, 0.58], confidence: 0.9, visibility: "visible", supportId: "bed" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    for (const id of ["throw_blanket", "tablecloth"]) {
      expect(byId.get(id)?.size[1]).toBe(0.08);
      expect(byId.get(id)?.supportComponentId).toBe("bed");
      expect(byId.get(id)?.position[1]).toBeCloseTo(0.576);
      expect(byId.get(id)?.notes).not.toContain("未按宽高比推断水平承载方向");
    }
  });

  it("uses the same furniture semantic profile for altar and small tables as for table dimensions", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        { id: "altar", name: "供桌", semanticType: "altar_table", bbox: [0.38, 0.42, 0.96, 0.82], confidence: 0.95, visibility: "visible" },
        { id: "stand", name: "小木几", semanticType: "small_table", bbox: [0.49, 0.62, 0.65, 0.82], confidence: 0.9, visibility: "visible" },
        { id: "dining", name: "餐桌", semanticType: "dining_table", bbox: [0.1, 0.4, 0.4, 0.65], confidence: 0.9, visibility: "visible" },
        { id: "garden", name: "户外桌", semanticType: "garden_table", bbox: [0.1, 0.4, 0.4, 0.65], confidence: 0.9, visibility: "visible" },
        { id: "bedside", name: "床头柜", semanticType: "bedside_table", bbox: [0.1, 0.4, 0.2, 0.6], confidence: 0.9, visibility: "visible" },
        { id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.4, 0.35, 0.5, 0.6], confidence: 0.9, visibility: "visible" },
        { id: "cloth", name: "桌布", semanticType: "tablecloth", bbox: [0.4, 0.6, 0.6, 0.7], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    for (const id of ["altar", "stand", "dining", "garden", "bedside"]) {
      const table = draft.components.find((component) => component.id === id)!;
      expect(table.category).toBe("table");
      expect(table.size[1]).toBe(0.75);
      expect(table.size[0]).toBeGreaterThan(0.25);
    }
    expect(draft.components.find((component) => component.id === "altar")?.size[0]).toBeCloseTo(3.5);
    expect(draft.components.find((component) => component.id === "stand")?.size[0]).toBeCloseTo(1.7066667);
    expect(draft.components.find((component) => component.id === "lamp")?.category).toBe("prop");
    expect(draft.components.find((component) => component.id === "cloth")?.size[1]).toBe(0.08);
  });

  it("does not infer a wide unknown prop is a horizontal support surface from bbox ratio alone", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [{ id: "tv", name: "横向电视", semanticType: "television", bbox: [0.2, 0.3, 0.8, 0.44], confidence: 0.9, visibility: "visible" }],
    }, source);
    const television = draft.components.find((component) => component.id === "tv")!;
    expect(television.size[1]).toBeGreaterThan(0.12);
    expect(television.uncertain).toBe(true);
    expect(television.notes).toContain("未按宽高比推断水平承载方向");
  });

  it("uses shared upright semantic height priors across names and leaves unknown props image-scaled", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        { id: "vase_a", name: "花瓶甲", semanticType: "vase", bbox: [0.1, 0.1, 0.2, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "vase_b", name: "decorative vessel", semanticType: "vase", bbox: [0.3, 0.1, 0.4, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "candlestick", name: "供桌烛具", semanticType: "candle_holder", bbox: [0.5, 0.1, 0.6, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "censer", name: "香薰器皿", semanticType: "incense_burner", bbox: [0.7, 0.1, 0.8, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "unknown", name: "unclassified object", semanticType: "unclassified_prop", bbox: [0.1, 0.1, 0.2, 0.55], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    expect(byId.get("vase_a")?.size[1]).toBe(0.55);
    expect(byId.get("vase_b")?.size[1]).toBe(0.55);
    expect(byId.get("vase_a")?.size).toEqual(byId.get("vase_b")?.size);
    expect(byId.get("candlestick")?.size[1]).toBe(0.38);
    expect(byId.get("censer")?.size[1]).toBe(0.55);
    expect(byId.get("unknown")?.size[1]).toBeGreaterThan(byId.get("vase_a")!.size[1]);
  });

  it("carries support and partOf components with their fitted parent", () => {
    const parent: LayoutDraftComponent = { id: "table", name: "table", category: "table", primitive: "box", position: [1, 0, 2], size: [2, 0.8, 1], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true };
    const supported: LayoutDraftComponent = { id: "statue", name: "statue", category: "prop", primitive: "box", position: [1.2, 0.8, 2.1], size: [0.4, 1, 0.4], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true, supportComponentId: "table" };
    const part: LayoutDraftComponent = { id: "detail", name: "detail", category: "prop", primitive: "box", position: [1.3, 0.2, 2.2], size: [0.2, 0.2, 0.2], rotationYDegrees: 0, confidence: 0.8, uncertain: true, visible: true, partOfComponentId: "table" };
    const movedParent = { ...parent, position: [1.6, 0, 1.5] as [number, number, number] };
    const carried = carryFittedParentMotion([movedParent], [parent, supported, part]);
    expect(carried.components.find((component) => component.id === "statue")?.position).toEqual([1.8, 0.8, 1.6]);
    expect(carried.components.find((component) => component.id === "detail")?.position[0]).toBeCloseTo(1.9);
    expect(carried.components.find((component) => component.id === "detail")?.position[2]).toBeCloseTo(1.7);
    expect(carried.movedComponentCount).toBe(3);
  });

  it("uses camera refinement before making estimated ground placements", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const truth: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `joint_${index}`, name: "fixture prop", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [1, 1, 1], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const priors = truth.map((component) => ({
      ...component,
      position: [component.position[0] + 0.35, 0, component.position[2] + 0.35] as [number, number, number],
    }));
    const pairs: CameraFitPair[] = truth.map((component, index) => ({ component: priors[index], confidence: 0.95, bbox: projectedBox(component, camera, 1), onGround: true }));
    const floor: LayoutDraftComponent = { id: "ground", name: "floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [6, 0.02, 6], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...priors, floor]);
    expect(fit.rejectionReason).toBeNull();
    expect(fit.movedCount).toBe(0);
    expect(fit.components).toEqual([]);
    expect(fit.physicalValidity?.cameraOutsideGeometry).toBe(true);
    expect(fit.best).toBeLessThan(fit.before!);
  });

  it("recovers a known camera with continuous position, target, and FOV refinement without moving objects", () => {
    const camera = { position: [0.35, 2.15, 7.4] as [number, number, number], target: [-0.25, 0.85, -0.4] as [number, number, number], fov: 57 };
    const truth: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `camera_truth_${index}`, name: "known fixture object", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [0.8, 1.4, 0.7], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = truth.map((component) => ({ component, confidence: 0.98, bbox: projectedBox(component, camera, 1.4) }));
    const floor: LayoutDraftComponent = { id: "known_ground", name: "ground", category: "ground", primitive: "box", position: [0, 0, 0], size: [8, 0.02, 8], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1.4, [...truth, floor]);

    expect(fit.rejectionReason).toBeNull();
    expect(fit.best).toBeLessThan(0.01);
    expect(fit.candidateCount).toBeGreaterThan(500);
    expect(fit.camera).not.toBe(fallback);
    expect(fit.components).toEqual([]);
    expect(fit.physicalValidity?.cameraOutsideGeometry).toBe(true);
    expect(fit.physicalValidity?.hardCollisionCount).toBe(0);
    const breakdown = cameraFitBreakdown(pairs, fit.camera!, 1.4);
    expect(breakdown.pairs).toHaveLength(pairs.length);
    expect(breakdown.pairs.map((item) => item.id)).toEqual(truth.map((component) => component.id));
    expect(breakdown.pairs.reduce((sum, item) => sum + item.weightedContribution, 0)).toBeCloseTo(breakdown.error, 8);
    expect(breakdown.pairs.every((item) => item.observedSize.every((size) => size > 0) && item.predictedSize.every((size) => size > 0))).toBe(true);
  });

  it("rejects camera and object fits that reverse confident, separated image order", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const truth: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `ordered_${index}`, name: "major prop", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [0.6, 1, 0.6], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const reversed = truth.map((component, index) => ({ ...component, position: [-truth[index].position[0], 0, -0.25] as [number, number, number] }));
    const pairs: CameraFitPair[] = truth.map((component, index) => ({ component: reversed[index], confidence: 0.95, bbox: projectedBox(component, camera, 1), onGround: true }));
    const floor: LayoutDraftComponent = { id: "ground", name: "floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [6, 0.02, 6], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...reversed, floor]);
    expect(fit.rejectionReason).toBe("no-safe-candidate");
    expect(fit.components).toEqual([]);
  });

  it("does not reject a fitted layout for extending beyond an estimated ground rectangle", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const truth: LayoutDraftComponent[] = [-3.35, 0, 3.35].map((x, index) => ({
      id: `edge_${index}`, name: "visible prop", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [0.5, 1, 0.5], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = truth.map((component) => ({ component, confidence: 0.95, bbox: projectedBox(component, camera, 1), onGround: true }));
    const estimatedFloor: LayoutDraftComponent = { id: "ground", name: "detected floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [6, 0.02, 6], rotationYDegrees: 0, confidence: 0.99, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...truth, estimatedFloor]);
    expect(fit.camera).not.toBe(fallback);
    expect(fit.physicalValidity?.withinRoom).toBe(false); // diagnostic only; the ground bbox is not a physical room boundary.
    expect(fit.physicalValidity?.roomBoundaryViolations.length).toBeGreaterThan(0);
    expect(fit.best).toBeLessThanOrEqual(0.22);
  });

  it.each([
    ["image_right", -90, 1],
    ["image_left", 90, -1],
  ] as const)("anchors a local -Z bed head to %s and mirrors yaw", (side, yaw, xSign) => {
    const draft = imageObservationToLayoutDraft(bedObservation(side), source, { draftId: "bed_" + side });
    const bed = draft.components.find((component) => component.id === "bed")!;

    expect(bed.rotationYDegrees).toBe(yaw);
    expect(Math.sign(bed.position[0])).toBe(xSign);
    expect(bed.position[0] + Math.sign(bed.position[0]) * bed.size[2] / 2).toBeCloseTo(xSign * 2.9);
    expect(bed.uncertain).toBe(true); // image bbox cannot fix depth along the wall.
    expect(bed.size[1]).toBe(1.2); // parent bounds include the raised headboard.
    expect(bed.appearance?.color).toBe("#F5F0E6");
    expect(bed.assembly).toHaveLength(5);
    for (const part of bed.assembly ?? []) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(part.position[axis] - part.size[axis] / 2).toBeGreaterThanOrEqual(0);
        expect(part.position[axis] + part.size[axis] / 2).toBeLessThanOrEqual(1);
      }
    }
    expect(draft.components.some((component) => component.id === "headboard")).toBe(false);
    expect(draft.observations?.some((observation) => observation.componentId === "bed" && observation.evidence?.includes("子部件"))).toBe(true);
    expect(draft.relations).toContainEqual({ fromId: "bed", toId: "anchor_wall", type: "head_at", confidence: 0.95 });
    const camera = draft.referenceCamera!;
    expect(camera).toMatchObject({ source: "bounds-fallback", imageAspectRatio: 1.5 });
    expect(camera.position[2]).toBeGreaterThan(camera.target[2]); // canonical camera faces from +Z toward -Z.
    expect(draft.validationWarnings ?? []).not.toContain("head_at_geometry_conflict");
  });

  it("anchors a bed head to the back wall at yaw zero", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.55], confidence: 0.9 }],
      items: [{ id: "bed", name: "床", semanticType: "bed", bbox: [0.25, 0.35, 0.8, 0.65], confidence: 0.9, visibility: "visible", againstSurfaceId: "back_wall" }],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    expect(bed.rotationYDegrees).toBe(0);
    expect(bed.position[2] - bed.size[2] / 2).toBeCloseTo(-2.9);
  });

  it("keeps floor furniture in the observed front-to-back order across wall and floor anchors", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "floor", kind: "floor", side: "floor", bbox: [0, 0.55, 1, 1], confidence: 0.98 },
        { id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0, 1, 0.62], confidence: 0.9 },
      ],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: [0.22, 0.38, 0.78, 0.65], confidence: 0.98, visibility: "visible", contactWallSide: "image_right" },
        { id: "rug", name: "rug", semanticType: "rug", bbox: [0.3, 0.6, 0.8, 0.73], confidence: 0.95, visibility: "visible", supportId: "floor" },
        { id: "desk", name: "desk", semanticType: "desk", bbox: [0.84, 0.5, 1, 0.68], confidence: 0.9, visibility: "partly_occluded", contactWallSide: "image_right" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    const bed = byId.get("bed")!;
    const rug = byId.get("rug")!;
    const desk = byId.get("desk")!;
    // Smaller Z is farther from the camera. The fixture's bbox bottoms order these as bed, desk, rug.
    expect(bed.position[2]).toBeLessThan(desk.position[2]);
    expect(desk.position[2]).toBeLessThan(rug.position[2]);
    expect(bed.position[2]).toBeLessThan(0);
    expect(rug.position[2]).toBeLessThan(0);
    expect(desk.uncertain).toBe(true); // partially occluded footprint stays an estimate.
  });

  it("maps explicit contact wall side and retains rear feature as evidence", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 }],
      items: [{
        id: "bed", name: "床", semanticType: "bed", bbox: [0.2, 0.35, 0.9, 0.7], confidence: 0.9,
        visibility: "visible", contactWallSide: "image_right", rearFeature: { name: "床头板", bbox: [0.78, 0.35, 0.9, 0.55] }, bodyExtendsToward: "image_left",
      }],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    expect(bed.rotationYDegrees).toBe(-90);
    expect(draft.relations).toContainEqual({ fromId: "bed", toId: "right_wall", type: "adjacent_to", confidence: 0.9 });
    expect(bed.notes).toContain("床头板");
    expect(bed.uncertain).toBe(true);
  });

  it.each([
    ["image_left", 90],
    ["image_right", -90],
    ["image_back", 0],
  ] as const)("uses an explicit headboard contact as the bed rear direction for %s", (side, yaw) => {
    const wall = side === "image_left" ? { id: "left", kind: "wall", side, bbox: [0, 0.2, 0.22, 0.7] }
      : side === "image_right" ? { id: "right", kind: "wall", side, bbox: [0.78, 0.2, 1, 0.7] }
        : { id: "back", kind: "wall", side, bbox: [0, 0.1, 1, 0.55] };
    const parentBox = [0.2, 0.35, 0.8, 0.7];
    const childBox = side === "image_left" ? [0.2, 0.4, 0.34, 0.58]
      : side === "image_right" ? [0.66, 0.4, 0.8, 0.58]
        : [0.4, 0.35, 0.6, 0.48];
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed", surfaces: [{ ...wall, confidence: 0.95 }],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: parentBox, confidence: 0.95, visibility: "visible", contactWallSide: "image_back" },
        { id: "headboard", name: "headboard", semanticType: "headboard", bbox: childBox, confidence: 0.92, visibility: "visible", contactWallSide: side, partOfId: "bed" },
      ],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    expect(bed.rotationYDegrees).toBe(yaw);
    expect(bed.notes).toContain("父普通接墙仅表示接触");
    expect(draft.relations).toContainEqual({ fromId: "bed", toId: wall.id, type: "head_at", confidence: 0.95 });
    expect(draft.observations?.some((observation) => observation.componentId === "bed" && observation.evidence?.includes("接触"))).toBe(true);
  });

  it("uses a visible non-bed backrest as the parent orientation constraint", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "back", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.55], confidence: 0.9 },
        { id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 },
      ],
      items: [
        { id: "sofa", name: "sofa", semanticType: "sofa", bbox: [0.2, 0.35, 0.78, 0.7], confidence: 0.9, visibility: "visible", contactWallSide: "image_back" },
        { id: "backrest", name: "backrest", semanticType: "backrest", bbox: [0.68, 0.4, 0.78, 0.6], confidence: 0.9, visibility: "visible", contactWallSide: "image_right", partOfId: "sofa" },
      ],
    }, source);
    expect(draft.components.find((component) => component.id === "sofa")?.rotationYDegrees).toBe(-90);
    expect(draft.components.find((component) => component.id === "backrest")).toBeDefined();
    expect(draft.relations).toContainEqual({ fromId: "sofa", toId: "right", type: "adjacent_to", confidence: 0.9 });
  });

  it("does not anchor a parent when rear parts conflict or parent rear evidence disagrees", () => {
    const base = {
      spaceType: "enclosed",
      surfaces: [
        { id: "back", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.55], confidence: 0.9 },
        { id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 },
      ],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: [0.2, 0.35, 0.78, 0.7], confidence: 0.9, visibility: "visible", contactWallSide: "image_back" },
        { id: "headboard-right", name: "headboard", semanticType: "headboard", bbox: [0.68, 0.4, 0.78, 0.6], confidence: 0.9, visibility: "visible", contactWallSide: "image_right", partOfId: "bed" },
        { id: "headboard-back", name: "headboard", semanticType: "headboard", bbox: [0.4, 0.35, 0.58, 0.48], confidence: 0.9, visibility: "visible", contactWallSide: "image_back", partOfId: "bed" },
      ],
    };
    const conflictingParts = imageObservationToLayoutDraft(base, source);
    const conflictedBed = conflictingParts.components.find((component) => component.id === "bed")!;
    expect(conflictedBed.uncertain).toBe(true);
    expect(conflictedBed.notes).toContain("与父级显式后侧方向证据冲突");
    expect(conflictingParts.observations?.some((observation) => observation.componentId === "bed" && observation.state === "ambiguous")).toBe(true);

    const disagreeingParent = imageObservationToLayoutDraft({
      ...base,
      items: [base.items[0], base.items[1], { ...base.items[2], contactWallSide: "image_right", bbox: [0.68, 0.4, 0.78, 0.6] }],
    }, source);
    expect(disagreeingParent.components.find((component) => component.id === "bed")?.uncertain).toBe(true);

    const rearFeatureConflict = imageObservationToLayoutDraft({
      ...base,
      items: [
        { ...base.items[0], rearFeature: { name: "rear panel", bbox: [0.22, 0.4, 0.34, 0.58] } },
        base.items[1],
      ],
    }, source);
    expect(rearFeatureConflict.components.find((component) => component.id === "bed")?.notes).toContain("未据此锚定");
  });

  it("does not let low-confidence or ambiguous rear parts determine parent yaw", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.95 }],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: [0.2, 0.35, 0.78, 0.7], confidence: 0.9, visibility: "visible" },
        { id: "headboard", name: "headboard", semanticType: "headboard", bbox: [0.68, 0.4, 0.78, 0.6], confidence: 0.5, visibility: "visible", contactWallSide: "image_right", partOfId: "bed" },
      ],
    }, source);
    expect(draft.components.find((component) => component.id === "bed")?.rotationYDegrees).toBe(0);
  });

  it.each(["unknown", "none"] as const)("does not fall back to a legacy wall id for explicit %s", (contactWallSide) => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 }],
      items: [{ id: "desk", name: "桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9,
        visibility: "visible", contactWallSide, againstSurfaceId: "right_wall" }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect((draft.relations ?? []).some((relation) => relation.toId === "right_wall")).toBe(false);
    expect(desk.uncertain).toBe(true);
    expect(desk.notes).toContain("新旧墙面关系冲突");
  });

  it("does not anchor a new side that conflicts with a legacy wall ID", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.2, 1, 0.7], confidence: 0.9 },
        { id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 },
      ],
      items: [{ id: "desk", name: "桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9,
        visibility: "visible", contactWallSide: "image_right", againstSurfaceId: "back_wall" }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect((draft.relations ?? []).some((relation) => relation.toId === "back_wall" || relation.toId === "right_wall")).toBe(false);
    expect(desk.uncertain).toBe(true);
    expect(desk.notes).toContain("新旧墙面关系冲突");
  });

  it("normalizes color and appearance.color without copying material properties", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [], items: [{ id: "desk", name: "桌", semanticType: "desk", bbox: [0.3, 0.3, 0.7, 0.7], confidence: 0.9, visibility: "visible", appearance: { color: "#abcdef", roughness: 0.3 } }],
    }, source);
    expect(draft.components.find((component) => component.id === "desk")?.appearance?.color).toBe("#ABCDEF");
    expect(draft.components.find((component) => component.id === "desk")?.appearance?.roughness).toBeUndefined();
  });

  it.each([
    ["image_right", -90, 1],
    ["image_left", 90, -1],
  ] as const)("orients a wall-mounted opening toward the room for %s", (side, yaw, xSign) => {
    const right = side === "image_right";
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "side_wall", kind: "wall", side, bbox: right ? [0.78, 0.2, 1, 0.64] : [0, 0.2, 0.22, 0.64], confidence: 0.95 }],
      items: [{
        id: "window", name: "窗", semanticType: "window", bbox: right ? [0.84, 0.32, 0.96, 0.5] : [0.04, 0.32, 0.16, 0.5],
        confidence: 0.9, visibility: "visible", againstSurfaceId: "side_wall",
      }],
    }, source);
    const window = draft.components.find((component) => component.id === "window")!;
    expect(window.rotationYDegrees).toBe(yaw);
    expect(getLayoutComponentRotationYDegrees(window)).toBe(yaw);
    expect(Math.sign(window.position[0])).toBe(xSign);
    expect(draft.validationWarnings ?? []).not.toContain("attachment_geometry_conflict");
  });

  it("maps opening height from the actual top edge of the observed wall bbox", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.2, 1, 0.8], confidence: 0.95 }],
      items: [
        { id: "window_top", name: "上窗", semanticType: "window", bbox: [0.3, 0.3, 0.5, 0.4], confidence: 0.9, visibility: "visible", againstSurfaceId: "back_wall" },
        { id: "window_bottom", name: "下窗", semanticType: "window", bbox: [0.3, 0.6, 0.5, 0.7], confidence: 0.9, visibility: "visible", againstSurfaceId: "back_wall" },
      ],
    }, source);
    const top = draft.components.find((component) => component.id === "window_top")!;
    const bottom = draft.components.find((component) => component.id === "window_bottom")!;
    expect(top.position[1]).toBeCloseTo(1.3); // schema keeps the opening inside the 2.8m wall top.
    expect(bottom.position[1]).toBe(0);
    expect(top.position[1]).toBeGreaterThan(bottom.position[1]);
  });

  it("preserves a non-bedroom outdoor wall anchor without inventing the other walls", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "outdoor",
      surfaces: [{ id: "back_facade", kind: "wall", side: "image_back", bbox: [0, 0.2, 1, 0.58], confidence: 0.9 }],
      items: [{
        id: "window", name: "窗", semanticType: "window", bbox: [0.4, 0.28, 0.6, 0.48], confidence: 0.9,
        visibility: "visible", againstSurfaceId: "back_facade", mainColor: "#ABCDEF",
      }],
    }, source);

    expect(draft.components.filter((component) => component.category === "wall")).toHaveLength(1);
    expect(draft.components.find((component) => component.id === "window")).toMatchObject({
      position: [expect.any(Number), expect.any(Number), expect.any(Number)], rotationYDegrees: 0,
      appearance: { color: "#ABCDEF" },
    });
    const window = draft.components.find((component) => component.id === "window")!;
    expect(window.position[1] + window.size[1]).toBeLessThanOrEqual(2.8);
    expect(draft.spaceType).toBe("outdoor");
  });

  it("keeps observed enclosed walls on one shared room footprint with continuous corners", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "back", kind: "wall", side: "image_back", bbox: [0.2, 0.2, 0.78, 0.58], confidence: 0.9 },
        { id: "left", kind: "wall", side: "image_left", bbox: [0, 0.2, 0.2, 0.58], confidence: 0.8 },
        { id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.58], confidence: 0.8 },
      ],
      items: [],
    }, source);
    const walls = draft.components.filter((component) => component.category === "wall");
    const back = walls.find((component) => component.id === "back")!;
    const left = walls.find((component) => component.id === "left")!;
    const right = walls.find((component) => component.id === "right")!;
    expect(walls).toHaveLength(3); // Do not invent the unseen front wall.
    expect(back.position).toEqual([0, 0, -3]);
    expect(back.size[0]).toBe(6);
    expect(left.position).toEqual([-3, 0, 0]);
    expect(right.position).toEqual([3, 0, 0]);
    expect(left.size[2]).toBe(6);
    expect(right.size[2]).toBe(6);
    expect(back.position[0] - back.size[0] / 2).toBe(left.position[0]);
    expect(back.position[0] + back.size[0] / 2).toBe(right.position[0]);
    expect(left.position[2] - left.size[2] / 2).toBe(back.position[2]);
    expect(left.position[2] + left.size[2] / 2).toBeCloseTo(3);
  });

  it("marks a wall cropped at the image top as an estimated height, not a measured ceiling", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "floor", kind: "floor", side: "floor", bbox: [0, 0.6, 1, 1], confidence: 0.95 },
        { id: "back", kind: "wall", side: "image_back", bbox: [0.35, 0, 1, 0.6], confidence: 0.9 },
      ],
      items: [{ id: "tall_prop", name: "雕像", semanticType: "statue", bbox: [0.6, 0.01, 0.8, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source);
    const wall = draft.components.find((component) => component.id === "back")!;
    expect(wall.uncertain).toBe(true);
    expect(wall.notes).toContain("2.8m墙高为先验估算");
    expect(draft.validationWarnings ?? []).not.toContain("component_exceeds_room_height");
  });

  it("uses an explicit support top even when the supported item appears first", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open",
      surfaces: [],
      items: [
        { id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.45, 0.4, 0.55, 0.6], confidence: 0.9, visibility: "visible", supportId: "table" },
        { id: "table", name: "桌", category: "table", semanticType: "table", bbox: [0.35, 0.4, 0.65, 0.62], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const lamp = draft.components.find((component) => component.id === "lamp")!;
    const table = draft.components.find((component) => component.id === "table")!;

    expect(lamp.supportComponentId).toBe("table");
    expect(lamp.position[1]).toBeCloseTo(table.position[1] + table.size[1] * 0.97);
    expect(draft.components.some((component) => component.category === "wall")).toBe(false);
    expect(lamp).toMatchObject({ supportComponentId: "table", uncertain: true }); // height is anchored; bbox-derived XZ still needs review.
  });

  it("contains a supported footprint inside a rotated support footprint", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.8, 0.1, 1, 0.9], confidence: 0.95 }],
      items: [
        { id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.7, 0.4, 0.9, 0.6], confidence: 0.9, visibility: "visible", supportId: "table" },
        { id: "table", name: "桌", category: "table", semanticType: "table", bbox: [0.3, 0.3, 0.7, 0.7], confidence: 0.9, visibility: "visible", contactWallSide: "image_right" },
      ],
    }, source);
    const lamp = draft.components.find((component) => component.id === "lamp")!;
    const table = draft.components.find((component) => component.id === "table")!;
    const angle = table.rotationYDegrees * Math.PI / 180;
    const childAngle = lamp.rotationYDegrees * Math.PI / 180;
    const halfSupportX = table.size[0] / 2;
    const halfSupportZ = table.size[2] / 2;
    for (const xSign of [-1, 1]) for (const zSign of [-1, 1]) {
      const childX = xSign * lamp.size[0] / 2;
      const childZ = zSign * lamp.size[2] / 2;
      const worldX = lamp.position[0] + Math.cos(childAngle) * childX + Math.sin(childAngle) * childZ;
      const worldZ = lamp.position[2] - Math.sin(childAngle) * childX + Math.cos(childAngle) * childZ;
      const dx = worldX - table.position[0];
      const dz = worldZ - table.position[2];
      const localX = Math.cos(angle) * dx - Math.sin(angle) * dz;
      const localZ = Math.sin(angle) * dx + Math.cos(angle) * dz;
      expect(Math.abs(localX)).toBeLessThanOrEqual(halfSupportX + 1e-6);
      expect(Math.abs(localZ)).toBeLessThanOrEqual(halfSupportZ + 1e-6);
    }
    expect(lamp.uncertain).toBe(true);
  });

  it("centers an oversized child on its support, keeps its size, and marks uncertainty", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "bed", name: "床", semanticType: "bed", bbox: [0.8, 0.8, 1, 1], confidence: 0.9, visibility: "visible", supportId: "vase" },
        { id: "vase", name: "花瓶", semanticType: "prop", bbox: [0.45, 0.45, 0.55, 0.55], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    const vase = draft.components.find((component) => component.id === "vase")!;
    expect(bed.position[0]).toBeCloseTo(vase.position[0]);
    expect(bed.position[2]).toBeCloseTo(vase.position[2]);
    expect(bed.size).toEqual([2, 1.2, 2.2]);
    expect(bed.uncertain).toBe(true);
    expect(bed.notes).toContain("子物件 footprint 大于支撑面");
  });

  it("maps observed people into the existing character contract instead of object boxes", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [{ id: "bench", name: "矮桌", semanticType: "table", category: "table", bbox: [0.4, 0.4, 0.6, 0.65], confidence: 0.9, visibility: "visible" }],
      people: [{ id: "actor", name: "人物", bbox: [0.45, 0.35, 0.55, 0.65], confidence: 0.75, visibility: "visible", posture: "sit", supportId: "bench" }],
    }, source);
    expect(draft.components.map((component) => component.id)).toEqual(["bench"]);
    expect(draft.characters).toHaveLength(1);
    expect(draft.characters[0]).toMatchObject({
      id: "actor", position: [expect.any(Number), 0.7275, expect.any(Number)], height: 1.7,
      posture: "sit", supportComponentId: "bench", uncertain: true,
    });
  });

  it("preserves explicit kneel variants and prayer gesture while retaining unknown posture", () => {
    const draft = imageObservationToLayoutDraft({
      surfaces: [],
      items: [{ id: "mat", name: "垫子", semanticType: "mat", bbox: [0.2, 0.65, 0.8, 0.75], confidence: 0.9, visibility: "visible" }],
      people: [
        { id: "praying", name: "跪拜女子", bbox: [0.3, 0.25, 0.45, 0.65], confidence: 0.95, visibility: "visible", posture: "kneel", facingDirection: "image_up", kneelVariant: "seiza", handGesture: "prayer", supportId: "mat" },
        { id: "unclear", name: "人物乙", bbox: [0.6, 0.2, 0.75, 0.7], confidence: 0.5, visibility: "uncertain", posture: "unknown", facingDirection: "unknown" },
      ],
    }, source);
    const praying = draft.characters.find((character) => character.id === "praying")!;
    const unclear = draft.characters.find((character) => character.id === "unclear")!;
    expect(praying).toMatchObject({ posture: "kneel", facingDirection: "image_up", rotationYDegrees: 180, kneelVariant: "seiza", handGesture: "prayer", supportComponentId: "mat" });
    const prayingAdapter = createLayoutCharacterRenderAdapter(praying);
    expect(prayingAdapter.characterRig.posePresetId).toBe("seiza");
    expect(prayingAdapter.characterRig.controls["leftElbow.bend"]).toBe(96);
    expect(prayingAdapter.transform.rotation[1]).toBeCloseTo(Math.PI);
    expect(unclear.posture).toBe("unknown");
    expect(unclear.facingDirection).toBe("unknown");
    expect(createLayoutCharacterRenderAdapter(unclear).characterRig.posePresetId).toBe("stand");
  });

  it.each(["missing", "cycle"] as const)("keeps %s support references at floor height and uncertain", (mode) => {
    const items = mode === "missing"
      ? [{ id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.45, 0.4, 0.55, 0.6], confidence: 0.9, visibility: "visible", supportId: "absent" }]
      : [
        { id: "a", name: "物件甲", category: "prop", bbox: [0.2, 0.4, 0.4, 0.6], confidence: 0.9, visibility: "visible", supportId: "b" },
        { id: "b", name: "物件乙", category: "prop", bbox: [0.6, 0.4, 0.8, 0.6], confidence: 0.9, visibility: "visible", supportId: "a" },
      ];
    const draft = imageObservationToLayoutDraft({ spaceType: "open", surfaces: [], items }, source);
    expect(draft.components.every((component) => component.position[1] === 0 && component.uncertain)).toBe(true);
    expect(draft.components.some((component) => component.category === "wall")).toBe(false);
  });

  it("places ordinary furniture against a wall without mounting it", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.8, 0.1, 1, 0.9], confidence: 0.95 }],
      items: [{ id: "desk", name: "书桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9, visibility: "visible", againstSurfaceId: "right_wall" }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect(desk.rotationYDegrees).toBe(-90);
    expect(desk.position[0] + desk.size[2] / 2).toBeCloseTo(2.9); // 2.925m wall inner face minus 0.025m gap.
    expect(desk.position[1]).toBe(0);
    expect(desk.uncertain).toBe(true);
    expect(draft.relations).toContainEqual({ fromId: "desk", toId: "right_wall", type: "adjacent_to", confidence: 0.9 });
  });

  it("keeps unsupported open-space items uncertain instead of adding walls", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [{ id: "prop", name: "物件", category: "prop", bbox: [0.4, 0.4, 0.6, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source);
    expect(draft.components).toHaveLength(1);
    expect(draft.components[0].category).toBe("prop");
    expect(draft.components[0].uncertain).toBe(true);
    expect(draft.spaceType).toBe("open");
  });

  it("does not fold a partOf item unless a known parent preset covers it", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "table", name: "桌子", semanticType: "table", category: "table", bbox: [0.2, 0.3, 0.8, 0.8], confidence: 0.9, visibility: "visible" },
        { id: "vase", name: "花瓶", semanticType: "prop", category: "prop", bbox: [0.4, 0.3, 0.6, 0.5], confidence: 0.9, visibility: "visible", partOfId: "table" },
      ],
    }, source);
    expect(draft.components.map((component) => component.id)).toContain("vase");
    expect(draft.components.find((component) => component.id === "vase")?.uncertain).toBe(true);
  });

  it("keeps cyclic partOf items instead of dropping both components", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "a", name: "物件甲", semanticType: "bed", bbox: [0.1, 0.3, 0.5, 0.8], confidence: 0.8, visibility: "visible", partOfId: "b" },
        { id: "b", name: "床头板", category: "cabinet", bbox: [0.4, 0.3, 0.6, 0.6], confidence: 0.8, visibility: "visible", partOfId: "a" },
      ],
    }, source);
    expect(draft.components.map((component) => component.id)).toEqual(["a", "b"]);
    expect(draft.components.every((component) => component.uncertain)).toBe(true);
  });

  it("keeps an invalid wall reference uncertain at bbox fallback without inventing a wall", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed", surfaces: [],
      items: [{ id: "cabinet", name: "柜子", semanticType: "cabinet", category: "cabinet", bbox: [0.2, 0.4, 0.4, 0.8], confidence: 0.9, visibility: "visible", againstSurfaceId: "x".repeat(5000) }],
    }, source);
    expect(draft.components).toHaveLength(1);
    const cabinet = draft.components[0];
    expect(cabinet).toMatchObject({ id: "cabinet", uncertain: true });
    expect(cabinet.position[0]).toBeCloseTo(-1.2);
    expect(cabinet.position[1]).toBe(0);
    expect(cabinet.position[2]).toBeCloseTo(1.6);
    expect(draft.relations).toBeUndefined();
    expect(draft.components.some((component) => component.category === "wall")).toBe(false);
  });

  it("prioritizes bounded observation and relation evidence and exposes truncation", () => {
    const items = Array.from({ length: 29 }, (_, index) => ({
      id: `item_${index}`,
      name: `物件${index}`,
      category: "prop",
      bbox: [0.1 + index * 0.001, 0.4, 0.3 + index * 0.001, 0.7],
      confidence: 0.8,
      visibility: "visible",
      againstSurfaceId: "back_wall",
    }));
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.9], confidence: 0.9 }],
      items,
    }, source);
    expect(draft.observations).toHaveLength(12);
    expect(draft.relations).toHaveLength(24);
    expect(draft.validationWarnings).toContain("observations_truncated");
    expect(draft.validationWarnings).toContain("relations_truncated");
  });

  it("leaves the existing legacy candidate path unchanged", () => {
    const legacy = validateLayoutDraftCandidate({
      components: [{
        id: "legacy_wall", name: "墙", category: "wall", primitive: "box", position: [0, 0, -3], size: [6, 2.8, 0.15],
        rotationYDegrees: 0, confidence: 0.8, uncertain: false,
      }],
    }, source);
    expect(legacy.components[0]).not.toHaveProperty("semanticType");
    expect(legacy.components[0]).not.toHaveProperty("assembly");
    expect(legacy.spaceType).toBeUndefined();
  });

  it("rejects an out-of-range normalized bbox", () => {
    expect(() => imageObservationToLayoutDraft({
      surfaces: [],
      items: [{ id: "bad", name: "物件", category: "prop", bbox: [-0.1, 0.2, 0.3, 0.4], confidence: 0.8, visibility: "visible" }],
    }, source)).toThrow(ImageObservationValidationError);
  });
});
