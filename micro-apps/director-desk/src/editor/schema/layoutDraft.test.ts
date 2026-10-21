import { describe, expect, it } from "vitest";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import {
  getUE4GroundedLabelY,
  getUE4SeatedPelvisSupportHeight,
} from "../runtime/ue4Mannequin/ue4MannequinRig";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "./viewportLabels";
import templeCurrentModelDraft from "./__fixtures__/temple-current-model-draft.json";
import {
  bindGeneratedAssetToLayoutDraft,
  buildLayoutBatch,
  calibrateLayoutDraft,
  createLayoutCharacterRenderAdapter,
  getLayoutCharacterCanonicalHeight,
  getLayoutComponentRenderPosition,
  getLayoutDraftReferenceCamera,
  LAYOUT_CATEGORY_COLORS,
  LAYOUT_CHARACTER_COLOR,
  LAYOUT_CHARACTER_NATIVE_HEIGHT,
  LAYOUT_CHARACTER_POSTURES,
  LAYOUT_POSTURE_TO_POSE_PRESET,
  LayoutDraftValidationError,
  validateLayoutDraftCandidate,
} from "./layoutDraft";

const source = { sourceId: "image_1", fileName: "room.png" };

it("binds a generated asset to the latest component while preserving intervening layout edits", () => {
  const draft = validateLayoutDraftCandidate({
    scale: { mode: "estimated", confidence: 0.4 },
    components: [{
      id: "sofa_1", name: "沙发", category: "sofa", primitive: "box",
      position: [1.2, 0.5, -0.3], size: [2.4, 0.9, 1.1], rotationYDegrees: 35,
      confidence: 0.5, uncertain: true, supportComponentId: "rug_1", notes: "保留的识别说明",
    }],
  }, source, { draftId: "draft_bind" });
  const notesBeforeBinding = draft.components[0].notes;
  const adopted = bindGeneratedAssetToLayoutDraft(draft, "sofa_1", "local_asset_1");

  expect(adopted?.components[0]).toMatchObject({
    position: [1.2, 0.5, -0.3], size: [2.4, 0.9, 1.1], rotationYDegrees: 35,
    supportComponentId: "rug_1", notes: notesBeforeBinding,
    generatedAssetRefId: "local_asset_1", generatedAssetNeedsReview: true, uncertain: true,
  });
  expect(draft.components[0]).not.toHaveProperty("generatedAssetRefId");
  expect(bindGeneratedAssetToLayoutDraft(draft, "missing", "local_asset_1")).toBeNull();
});

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

function candidateWithCharacters() {
  return {
    ...candidate(),
    characters: [{
      id: "char_01",
      name: "人物甲",
      position: [1.2, 0, 0.4],
      height: 1.7,
      rotationYDegrees: 90,
      posture: "stand",
      bodyTypeHint: "male",
      confidence: 0.86,
      uncertain: false,
      visible: true,
    }, {
      id: "char_02",
      name: "人物乙",
      position: [0.2, 0.45, -0.1],
      height: 1.62,
      rotationYDegrees: 180,
      posture: "sit",
      bodyTypeHint: "female",
      confidence: 0.7,
      uncertain: false,
      notes: "坐在沙发上",
      visible: true,
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
      color: LAYOUT_CATEGORY_COLORS.wall,
    });
  });

  it("omits new optional layout metadata when normalizing legacy components and characters", () => {
    const draft = validateLayoutDraftCandidate(candidateWithCharacters(), source);

    expect(draft.components[0]).not.toHaveProperty("semanticType");
    expect(draft.components[0]).not.toHaveProperty("supportComponentId");
    expect(draft.components[0]).not.toHaveProperty("assembly");
    expect(draft.characters[0]).not.toHaveProperty("supportComponentId");
  });

  it("keeps crop evidence in the draft and carries only a local generated asset binding into the applied object", () => {
    const value = candidate();
    value.components[0] = {
      ...value.components[0],
      sourceImageEvidence: { bbox: [0.1, 0.2, 0.6, 0.8], confidence: 0.88, visibility: "visible" },
      generatedAssetRefId: "local_asset_generated_glb",
      generatedAssetNeedsReview: true,
    } as typeof value.components[0];
    const draft = validateLayoutDraftCandidate(value, source);
    const object = buildLayoutBatch(draft, "layout_generated", []).objects[0];

    expect(draft.components[0].sourceImageEvidence).toEqual({
      bbox: [0.1, 0.2, 0.6, 0.8],
      confidence: 0.88,
      visibility: "visible",
    });
    expect(object.assetRefId).toBe("local_asset_generated_glb");
    expect(object.layoutSource).toMatchObject({
      generatedAssetSource: "reference-image-object-v1",
      generatedAssetFit: "uniform-contained-bottom-center-v1",
      generatedAssetFitTargetSize: [6, 2.8, 0.15],
      generatedAssetNeedsReview: true,
    });
    expect(object.layoutSource).not.toHaveProperty("catalogFit");
    expect(object.layoutSource).not.toHaveProperty("sourceImageEvidence");
    expect(JSON.stringify(object)).not.toContain("capability");
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
    expect(getLayoutDraftReferenceCamera(calibrated)).toMatchObject({
      source: "bounds-fallback",
      confidence: 0,
    });
  });

  it("preserves a model reference camera for the applied batch", () => {
    const value: any = candidate();
    value.referenceCamera = {
      projection: "perspective",
      position: [1, 1.7, 7],
      target: [0, 1.1, -2],
      fov: 46,
      confidence: 0.62,
    };

    const draft = validateLayoutDraftCandidate(value, source);
    const built = buildLayoutBatch(draft, "layout_camera", []);
    expect(draft.referenceCamera).toEqual({ ...value.referenceCamera, source: "model" });
    expect(built.batch.referenceCamera).toEqual(draft.referenceCamera);
  });

  it("bounds numeric camera-fit pair diagnostics to ten safe entries", () => {
    const value: any = candidate();
    const pair = {
      id: "object_01",
      observedCenter: [0.5, 0.5], observedSize: [0.2, 0.3],
      predictedCenter: [0.51, 0.49], predictedSize: [0.19, 0.31],
      centerError: 0.014, scaleError: 0.1, weightedContribution: 0.01,
    };
    value.referenceCamera = {
      projection: "perspective", position: [0, 1.6, 6], target: [0, 1, 0], fov: 50, confidence: 0.1, source: "estimated",
      fitDiagnostics: {
        qualityStatus: "needsReview", itemCount: 10, candidateCount: 512,
        baselineProjectionError: 0.8, bestProjectionError: 0.3, cameraOnlyBestProjectionError: 0.3,
        bestCandidate: { position: [0, 1.6, 6], target: [0, 1, 0], fov: 50 },
        applied: true, rejectionReason: "error-too-high",
        pairDiagnostics: [{ ...pair, observedCenter: [0, Number.NaN] }, ...Array.from({ length: 11 }, (_, index) => ({ ...pair, id: `object_${index}` }))],
      },
    };
    const draft = validateLayoutDraftCandidate(value, source);
    expect(draft.referenceCamera?.fitDiagnostics?.candidateCount).toBe(512);
    expect(draft.referenceCamera?.fitDiagnostics?.pairDiagnostics).toHaveLength(10);
    expect(draft.referenceCamera?.fitDiagnostics?.pairDiagnostics?.[0]).toEqual({ ...pair, id: "object_0" });
  });

  it("preserves constrained model and material hints through the applied object", () => {
    const value: any = candidate();
    value.components[0] = {
      ...value.components[0],
      modelDescriptor: "深色木质餐桌",
      appearance: { color: "#6A4729", roughness: 0.42, metalness: 0.08, frontDirectionDegrees: 90 },
    };
    const draft = validateLayoutDraftCandidate(value, source);
    const built = buildLayoutBatch(draft, "layout_appearance", []);
    expect(built.objects[0].layoutSource).toMatchObject({
      modelDescriptor: "深色木质餐桌",
      appearance: { color: "#6A4729", roughness: 0.42, metalness: 0.08, frontDirectionDegrees: 90 },
    });
    expect(built.objects[0].color).toBe("#6A4729");
    expect(built.objects[0].transform.rotation[1]).toBeCloseTo(Math.PI / 2);
  });

  it("normalizes bounded spatial metadata and safely snaps an explicitly attached opening to a rotated wall", () => {
    const value: any = candidate();
    value.spaceType = "open";
    value.observations = [{ componentId: "wall_01", state: "visible", confidence: 0.9, evidence: "visible wall" }];
    value.components.push({
      id: "door_01", name: "门", category: "door", primitive: "box",
      position: [0.25, 0, -2.8], size: [0.9, 2, 0.12], rotationYDegrees: 0,
      confidence: 0.9, visible: true,
    });
    value.components[0] = { ...value.components[0], position: [0, 0, 0], rotationYDegrees: 37, semanticType: "wall" };
    const radians = 37 * Math.PI / 180;
    value.components[1].position = [Math.sin(radians) * 0.5, 0, Math.cos(radians) * 0.5];
    value.relations = [{ fromId: "door_01", toId: "wall_01", type: "attached_to", confidence: 0.96 }];

    const draft = validateLayoutDraftCandidate(value, source);
    const door = draft.components.find((component) => component.id === "door_01")!;
    expect(draft.spaceType).toBe("open");
    expect(draft.observations).toEqual([{ componentId: "wall_01", state: "visible", confidence: 0.9, evidence: "visible wall" }]);
    expect(draft.relations).toEqual(value.relations);
    expect(draft.validationWarnings).toContain("attachment_adjusted_review");
    expect(door.rotationYDegrees).toBeCloseTo(37);
    expect(door.position[0]).toBeCloseTo(0);
    expect(door.position[2]).toBeCloseTo(0);
    expect(door.uncertain).toBe(true);
  });

  it("drops invalid or unknown relation endpoints as warnings without changing geometry", () => {
    const value: any = candidate();
    value.components[0].semanticType = "bed";
    value.relations = [
      { fromId: "wall_01", toId: "missing", type: "attached_to", confidence: 0.99 },
      { fromId: "wall_01", toId: "wall_01", type: "nearish", confidence: 0.9 },
    ];
    const draft = validateLayoutDraftCandidate(value, source);
    expect(draft.components[0].position).toEqual([0, 0, -3]);
    expect(draft.relations).toBeUndefined();
    expect(draft.validationWarnings).toContain("relation_endpoint_missing");
    expect(draft.validationWarnings).toContain("relation_invalid");
  });

  it("warns when a structured draft has no visible colors while keeping legacy drafts compatible", () => {
    const structured: any = candidate();
    structured.spaceType = "enclosed";
    structured.observations = [{ componentId: "wall_01", state: "visible", confidence: 0.9 }];
    const draft = validateLayoutDraftCandidate(structured, source);
    expect(draft.validationWarnings).toContain("appearance_color_missing");

    const legacyDraft = validateLayoutDraftCandidate(candidate(), source);
    expect(legacyDraft.validationWarnings ?? []).not.toContain("appearance_color_missing");
  });

  it("marks invalid head_at endpoint direction for review instead of silently accepting it", () => {
    const value: any = candidate();
    value.components.push({
      id: "headboard_01", name: "床头板", category: "cabinet", primitive: "box",
      position: [0, 0.6, -2], size: [2, 1, 0.15], rotationYDegrees: 0,
      confidence: 0.9, visible: true,
    });
    value.relations = [{ fromId: "headboard_01", toId: "wall_01", type: "head_at", confidence: 0.9 }];
    const draft = validateLayoutDraftCandidate(value, source);
    expect(draft.validationWarnings).toContain("head_at_endpoint_invalid");
    expect(draft.components.find((component) => component.id === "headboard_01")?.uncertain).toBe(true);
  });

  it("warns and preserves geometry when a visible component exceeds known enclosed wall height", () => {
    const value: any = candidate();
    value.spaceType = "enclosed";
    value.components.push({
      id: "tall_object", name: "物件", category: "cabinet", primitive: "box",
      position: [0, 1.5, 0], size: [1, 2, 1], rotationYDegrees: 0,
      confidence: 0.9, visible: true,
    });
    const draft = validateLayoutDraftCandidate(value, source);
    const item = draft.components.find((component) => component.id === "tall_object")!;
    expect(draft.validationWarnings).toContain("component_exceeds_room_height");
    expect(item.position).toEqual([0, 1.5, 0]);
    expect(item.uncertain).toBe(true);

    value.spaceType = "open";
    const openDraft = validateLayoutDraftCandidate(value, source);
    expect(openDraft.validationWarnings ?? []).not.toContain("component_exceeds_room_height");
    expect(openDraft.components.find((component) => component.id === "tall_object")?.uncertain).toBe(false);
  });

  it("reports a conflicting head_at relation against a rotated wall without moving the bed", () => {
    const value: any = candidate();
    value.components[0] = { ...value.components[0], position: [4, 0, 0], rotationYDegrees: 31 };
    value.components.push({
      id: "bed_01", name: "床", category: "prop", primitive: "box", semanticType: "bed",
      position: [0, 0, 3], size: [2, 0.5, 2], rotationYDegrees: 0, confidence: 0.9, visible: true,
    });
    value.relations = [{ fromId: "bed_01", toId: "wall_01", type: "head_at", confidence: 0.92 }];
    const draft = validateLayoutDraftCandidate(value, source);
    const bed = draft.components.find((component) => component.id === "bed_01")!;
    expect(bed.position).toEqual([0, 0, 3]);
    expect(bed.uncertain).toBe(true);
    expect(bed.notes).toContain("head_at");
    expect(draft.validationWarnings).toContain("head_at_geometry_conflict");
  });

  it("keeps a bounded declarative assembly and rejects parts outside the parent bounds", () => {
    const value: any = candidate();
    value.components[0].semanticType = "bed";
    value.components[0] = { ...value.components[0], assembly: [
      { primitive: "box", position: [0.5, 0.82, 0.5], size: [0.9, 0.1, 0.7] },
      { primitive: "cylinder", position: [0.15, 0.4, 0.18], size: [0.1, 0.75, 0.1] },
    ] };
    expect(buildLayoutBatch(validateLayoutDraftCandidate(value, source), "layout_assembly", []).objects[0].layoutSource?.assembly).toHaveLength(2);
    value.components[0].assembly[0].position = [1, 0.5, 0.5];
    expect(() => validateLayoutDraftCandidate(value, source)).toThrow("assembly");
  });

  it("fills missing bed, curtain, and bookshelf assemblies while preserving the parent box and preview/apply payload", () => {
    const value: any = candidate();
    value.components = ["bed", "curtain", "bookshelf"].map((semanticType, index) => ({
      id: semanticType,
      name: semanticType,
      category: "prop",
      primitive: "box",
      semanticType,
      position: [index * 3, 0, 0],
      size: [2, 1, 0.8],
      rotationYDegrees: index * 37,
      confidence: 0.9,
      visible: true,
    }));
    const draft = validateLayoutDraftCandidate(value, source);
    const built = buildLayoutBatch(draft, "layout_semantic", []);
    expect(draft.components.map((component) => component.assembly?.length)).toEqual([5, 4, 7]);
    expect(draft.components[1].assembly?.find((part) => part.opacity !== undefined)?.opacity).toBe(0.35);
    draft.components.forEach((component) => {
      const applied = built.objects.find((object) => object.layoutSource?.componentId === component.id)!;
      expect(applied.layoutSource?.assembly).toEqual(component.assembly);
      expect(applied.transform).toMatchObject({ position: component.position, scale: component.size });
      expect(component.assembly?.every((part) => part.opacity === undefined || (part.opacity >= 0.15 && part.opacity <= 1))).toBe(true);
    });
  });

  it("builds shared normalized assemblies for common furniture and prop profiles", () => {
    const semanticTypes = ["table", "altar_table", "small_table", "nightstand", "cabinet", "sculpture", "figurine", "vase", "bottle", "jar", "container", "urn", "censer", "incense_burner", "candlestick", "lantern", "table_lamp", "desk_lamp", "floor_lamp", "hanging_lamp", "plant", "flower", "potted_plant", "pillow", "cushion", "blanket"];
    const value: any = candidate();
    value.components = semanticTypes.map((semanticType, index) => ({
      id: `generic_${index}`,
      name: semanticType,
      category: "prop",
      primitive: "box",
      semanticType,
      position: [index * 3, 0, 0],
      size: [1.2, 1.5, 0.8],
      rotationYDegrees: 0,
      confidence: 0.9,
      visible: true,
    }));
    value.components.push({ ...value.components[0], id: "unknown", name: "unclassified prop", semanticType: "unclassified_prop" });
    const draft = validateLayoutDraftCandidate(value, source);

    for (const component of draft.components.slice(0, semanticTypes.length)) {
      expect(component.assembly?.length).toBeGreaterThanOrEqual(2);
      expect(component.assembly?.every((part) => [0, 1, 2].every((axis) =>
        part.position[axis] - part.size[axis] / 2 >= -1e-6 && part.position[axis] + part.size[axis] / 2 <= 1 + 1e-6,
      )), component.id).toBe(true);
    }
    expect(draft.components[draft.components.length - 1]?.assembly).toBeUndefined();
    const assemblyFor = (semanticType: string) => draft.components.find((component) => component.semanticType === semanticType)?.assembly;
    expect(assemblyFor("table")).toEqual(assemblyFor("altar_table"));
    expect(assemblyFor("table")).toEqual(assemblyFor("small_table"));
    expect(assemblyFor("sculpture")).toEqual(assemblyFor("figurine"));
    expect(assemblyFor("vase")).toEqual(assemblyFor("bottle"));
    expect(assemblyFor("vase")).toEqual(assemblyFor("jar"));
    expect(assemblyFor("vase")).toEqual(assemblyFor("censer"));
    expect(assemblyFor("vase")).toEqual(assemblyFor("incense_burner"));
    expect(assemblyFor("table_lamp")).toEqual(assemblyFor("floor_lamp"));
    expect(assemblyFor("plant")).toEqual(assemblyFor("flower"));
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

  it("keeps preview and applied ground top 2mm above the scene floor for different thicknesses", () => {
    for (const thickness of [0.02, 0.1]) {
      const value = candidate();
      value.components[0] = {
        ...value.components[0],
        id: "ground_01",
        name: "地面",
        category: "ground",
        position: [0, 0.3, 0],
        size: [6, thickness, 6],
      };
      const draft = validateLayoutDraftCandidate(value, source);
      const ground = draft.components[0];
      const previewPosition = getLayoutComponentRenderPosition(ground, 0.75);
      const applied = buildLayoutBatch(draft, `layout_ground_${thickness}`, [], 0.75).objects[0];
      const previewWorldTop = previewPosition[1] + ground.size[1];
      const appliedWorldTop = applied.transform.position[1] + applied.transform.scale[1];

      expect(previewWorldTop).toBeCloseTo(0.752);
      expect(appliedWorldTop).toBeCloseTo(previewWorldTop);
      expect(applied.transform.position).toEqual(previewPosition);
    }
  });

  it("keeps preview and apply ground placement identical for the real temple response", () => {
    const draft = validateLayoutDraftCandidate(templeCurrentModelDraft, source, { draftId: "temple_real_raw" });
    const ground = draft.components.find((component) => component.id === "ground_01")!;
    const previewPosition = getLayoutComponentRenderPosition(ground, 0);
    const built = buildLayoutBatch(draft, "temple_real_raw", [], 0);
    const appliedGround = built.objects.find((object) => object.layoutSource?.componentId === "ground_01")!;

    expect(ground.position[1]).toBe(-0.05);
    expect(previewPosition).toEqual([0, -0.098, 0]);
    expect(appliedGround.transform.position).toEqual(previewPosition);
    expect(previewPosition[1] + ground.size[1]).toBeCloseTo(0);
  });

  it("normalizes legacy center-Y walls while preserving valid elevated props", () => {
    const withExplicitCushionSupport = structuredClone(templeCurrentModelDraft) as any;
    withExplicitCushionSupport.characters[0].supportComponentId = "prop_cushion_01";
    const draft = validateLayoutDraftCandidate(withExplicitCushionSupport, source, { draftId: "temple_diagnostics" });
    const backWall = draft.components.find((component) => component.id === "wall_back_01")!;
    const vase = draft.components.find((component) => component.id === "prop_vase_01")!;
    const character = draft.characters[0];

    expect(backWall.position[1]).toBe(0);
    expect(backWall.uncertain).toBe(true);
    expect(backWall.notes).toContain("已按底部中心语义修正");
    expect(vase.position[1]).toBe(1.15);
    expect(character.position[1]).toBe(0.12);
    expect(character.uncertain).toBe(true);
    expect(character.notes).toContain("顶面不等于可确认座面/承载面");

    const revalidated = validateLayoutDraftCandidate(draft, source, { draftId: "temple_diagnostics_again" });
    expect(revalidated.components.find((component) => component.id === "wall_back_01")!.notes!.match(/已按底部中心语义修正/g)).toHaveLength(1);
    expect(revalidated.components.find((component) => component.id === "wall_back_01")!.notes!.length).toBeLessThanOrEqual(240);
  });

  it("flags a door or window that is not attached to a wall without discarding the editable draft", () => {
    const value: any = candidate();
    value.components.push({
      id: "window_orphan", name: "孤立窗", category: "window", primitive: "box",
      position: [5, 1, 0], size: [1, 1, 0.1], rotationYDegrees: 0,
      confidence: 0.9, uncertain: false,
    });

    const draft = validateLayoutDraftCandidate(value, source);
    const window = draft.components.find((component) => component.id === "window_orphan")!;
    expect(window.uncertain).toBe(true);
    expect(window.notes).toContain("窗未依附可识别墙面");
  });

  it("recognizes and carves a door on the long Z axis of a wall", () => {
    const value: any = candidate();
    value.components = [{
      id: "wall_left", name: "左墙", category: "wall", primitive: "box",
      position: [-3, 0, 0], size: [0.15, 2.8, 7], rotationYDegrees: 0,
      confidence: 0.8, uncertain: false,
    }, {
      id: "door_left", name: "门", category: "door", primitive: "box",
      position: [-3, 0, 0.9], size: [0.9, 2.05, 0.08], rotationYDegrees: 90,
      confidence: 0.75, uncertain: false,
    }];

    const draft = validateLayoutDraftCandidate(value, source);
    const door = draft.components.find((component) => component.id === "door_left")!;
    const carvedWall = draft.components.filter((component) => component.id.startsWith("wall_left_"));
    expect(door.uncertain).toBe(false);
    expect(door.notes).toBeUndefined();
    expect(carvedWall.map((component) => component.id)).toEqual(["wall_left_left", "wall_left_right", "wall_left_top"]);
    expect(carvedWall.every((component) => component.size[0] === 0.15)).toBe(true);
    expect(carvedWall.find((component) => component.id === "wall_left_top")!.position[1]).toBe(2.05);
  });

  it("resolves explicit support top-down only when horizontal footprints overlap", () => {
    const value: any = candidateWithCharacters();
    value.components = [
      {
        id: "ground_01", name: "地面", category: "ground", primitive: "box",
        position: [0, -0.05, 0], size: [8, 0.1, 8], rotationYDegrees: 0,
        confidence: 0.9, uncertain: false,
      },
      {
        id: "cushion_01", name: "坐垫", category: "prop", primitive: "box",
        position: [0, 0.06, 0], size: [0.8, 0.12, 0.8], rotationYDegrees: 0,
        supportComponentId: "ground_01", confidence: 0.9, uncertain: false,
      },
      {
        id: "far_prop", name: "远处道具", category: "prop", primitive: "box",
        position: [4, 0.4, 4], size: [0.2, 0.2, 0.2], rotationYDegrees: 0,
        supportComponentId: "cushion_01", confidence: 0.9, uncertain: false,
      },
    ];
    value.characters = [{
      ...value.characters[0],
      id: "char_kneel",
      posture: "kneel",
      kneelVariant: "seiza",
      position: [0, 0.06, 0],
      supportComponentId: "cushion_01",
    }];

    const draft = validateLayoutDraftCandidate(value, source);
    const cushion = draft.components.find((component) => component.id === "cushion_01")!;
    const farProp = draft.components.find((component) => component.id === "far_prop")!;
    expect(cushion.position[1]).toBe(0);
    expect(draft.characters[0].position[1]).toBe(0.06);
    expect(draft.characters[0].uncertain).toBe(true);
    expect(farProp.position[1]).toBe(0.4);
    expect(farProp.uncertain).toBe(true);
    expect(farProp.notes).toContain("包围盒顶面不代表可确认承载面");
  });

  it("does not accept support through a confidently observed assembly opening", () => {
    const value: any = candidateWithCharacters();
    value.components = [
      {
        id: "open_table", name: "桌", category: "table", primitive: "box",
        position: [0, 0.5, 0], size: [2, 1, 2], rotationYDegrees: 0,
        confidence: 0.95, uncertain: false, supportComponentId: "ground_01",
        assembly: [
          { primitive: "box", position: [0.5, 0.91, 0.5], size: [0.98, 0.12, 0.92] },
          ...[0.1, 0.9].flatMap((x) => [0.1, 0.9].map((z) => ({ primitive: "box", position: [x, 0.4, z], size: [0.11, 0.72, 0.11] }))),
        ],
        groundFootprint: [{ confidence: 0.95, outer: [[0, 0], [1, 0], [1, 1], [0, 1]], holes: [[[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65]]] }],
      },
      { id: "ground_01", name: "地面", category: "ground", primitive: "box", position: [0, -0.05, 0], size: [8, 0.1, 8], rotationYDegrees: 0, confidence: 0.95, uncertain: false },
      { id: "bowl", name: "碗", category: "prop", primitive: "box", position: [0, 1.2, 0], size: [0.2, 0.2, 0.2], rotationYDegrees: 0, confidence: 0.95, uncertain: false, supportComponentId: "open_table" },
    ];
    value.characters = [];
    const draft = validateLayoutDraftCandidate(value, source);
    const bowl = draft.components.find((component) => component.id === "bowl")!;
    expect(bowl.position[1]).toBe(1.2);
    expect(bowl.uncertain).toBe(true);
    expect(bowl.notes).toContain("水平足迹不重叠");
  });
});

describe("layout draft characters", () => {
  it("keeps characters absent for pure-layout images", () => {
    const draft = validateLayoutDraftCandidate(candidate(), source);

    expect(draft.characters).toEqual([]);
  });

  it("passes through valid characters and builds editable role objects", () => {
    const draft = validateLayoutDraftCandidate(candidateWithCharacters(), source, {
      draftId: "draft_chars",
      createdAt: "2026-10-12T00:00:00.000Z",
    });
    const built = buildLayoutBatch(draft, "layout_chars", []);

    expect(draft.characters).toHaveLength(2);
    expect(draft.characters[0]).toMatchObject({
      id: "char_01",
      name: "人物甲",
      posture: "stand",
      height: 1.7,
      position: [1.2, 0, 0.4],
      uncertain: false,
    });

    const [wall, standing, sitting] = built.objects;
    expect(built.batch.objectIds).toEqual([wall.id, standing.id, sitting.id]);

    // 站立人物：身高换算成整体等比缩放，位置即接触面中心
    expect(standing).toMatchObject({
      kind: "character",
      name: "人物甲",
      bodyType: "mannequin",
      color: LAYOUT_CHARACTER_COLOR,
      characterRig: { rigType: "ue4-mannequin", posePresetId: "stand", controls: {} },
      layoutSource: {
        batchId: "layout_chars",
        category: "character",
        characterMeta: { posture: "stand", height: 1.7 },
      },
    });
    expect(standing.transform.position).toEqual([1.2, 0, 0.4]);
    expect(standing.transform.scale[0]).toBeCloseTo(1.7 / LAYOUT_CHARACTER_NATIVE_HEIGHT);
    expect(standing.transform.scale[1]).toBeCloseTo(standing.transform.scale[0]);
    expect(standing.transform.rotation[1]).toBeCloseTo(Math.PI / 2);

    // 坐姿人物：草稿位置保留座面高度，渲染 root 按实际 female 骨盆座面锚点下移
    expect(sitting).toMatchObject({
      kind: "character",
      bodyType: "female",
      characterRig: { posePresetId: "sit" },
      layoutSource: { category: "character", characterMeta: { posture: "sit", height: 1.62 } },
    });
    const femaleScale = 1.62 / getLayoutCharacterCanonicalHeight("female");
    expect(sitting.transform.position[0]).toBe(0.2);
    expect(sitting.transform.position[1]).toBeCloseTo(
      0.45 - getUE4SeatedPelvisSupportHeight("female") * femaleScale,
    );
    expect(sitting.transform.position[2]).toBe(-0.1);
    expect(sitting.transform.scale[0]).toBeCloseTo(femaleScale);
    expect(sitting.characterRig?.controls).toMatchObject({
      "leftHip.pitch": 80,
      "rightKnee.bend": 90,
    });
  });

  it("maps every posture onto an existing pose preset", () => {
    LAYOUT_CHARACTER_POSTURES.forEach((posture) => {
      const presetId = LAYOUT_POSTURE_TO_POSE_PRESET[posture];
      expect(MANNEQUIN_POSE_PRESETS.some((preset) => preset.id === presetId)).toBe(true);
    });
  });

  it("keeps legacy kneel drafts on one knee and maps explicit variants including seiza", () => {
    const value = candidateWithCharacters() as ReturnType<typeof candidateWithCharacters> & { characters: Array<Record<string, unknown>> };
    value.characters[0] = {
      ...value.characters[0],
      posture: "kneel",
      kneelVariant: "seiza",
      handGesture: "prayer",
      position: [0.2, 0.12, 0.4],
    };
    value.characters[1] = {
      ...value.characters[1],
      posture: "kneel",
      kneelVariant: undefined,
      position: [1, 0, 0],
    };
    const draft = validateLayoutDraftCandidate(value, source);
    const seiza = createLayoutCharacterRenderAdapter(draft.characters[0]);
    const legacy = createLayoutCharacterRenderAdapter(draft.characters[1]);

    expect(draft.characters[0].kneelVariant).toBe("seiza");
    expect(seiza.characterRig.posePresetId).toBe("seiza");
    expect(seiza.transform.position[1]).toBeCloseTo(0.12);
    expect(seiza.characterRig.controls).toMatchObject({
      "leftHip.pitch": 68,
      "rightKnee.bend": 142,
      "leftElbow.bend": 96,
      "rightElbow.bend": 96,
    });
    expect(legacy.characterRig.posePresetId).toBe("kneel-one");
  });

  it("accepts pillar and supported prop placement above the floor", () => {
    const value = candidateWithCharacters();
    value.components.push({
      id: "pillar_01", name: "立柱", category: "pillar", primitive: "cylinder",
      position: [-1.2, 0, -2], size: [0.4, 2.8, 0.4], rotationYDegrees: 0,
      confidence: 0.9, uncertain: false,
    }, {
      id: "incense_01", name: "香炉", category: "prop", primitive: "cylinder",
      position: [0.4, 0.82, -2.4], size: [0.45, 0.35, 0.45], rotationYDegrees: 0,
      confidence: 0.82, uncertain: false,
    });

    const draft = validateLayoutDraftCandidate(value, source);
    expect(draft.components.find((item) => item.category === "pillar")?.size[1]).toBe(2.8);
    expect(draft.components.find((item) => item.category === "prop")?.position[1]).toBe(0.82);
  });

  it("keeps the native height in sync with the grounded label anchor", () => {
    expect(LAYOUT_CHARACTER_NATIVE_HEIGHT).toBeCloseTo(
      getUE4GroundedLabelY("mannequin") - VIEWPORT_OBJECT_LABEL_VERTICAL_GAP,
      5,
    );
  });

  it("clamps out-of-range heights and marks them uncertain", () => {
    const value = candidateWithCharacters();
    value.characters[0] = { ...value.characters[0], height: 9 };
    value.characters[1] = { ...value.characters[1], height: 0.1 };
    const draft = validateLayoutDraftCandidate(value, source);

    expect(draft.characters[0].height).toBe(2.5);
    expect(draft.characters[0].uncertain).toBe(true);
    expect(draft.characters[0].notes).toContain("身高已夹紧");
    expect(draft.characters[1].height).toBe(0.5);
    expect(draft.characters[1].uncertain).toBe(true);
  });

  it("falls back to unknown posture for unsupported values", () => {
    const value = candidateWithCharacters();
    value.characters[0] = { ...value.characters[0], posture: "handstand" };
    const draft = validateLayoutDraftCandidate(value, source);

    expect(draft.characters[0].posture).toBe("unknown");
    expect(draft.characters[0].uncertain).toBe(true);
  });

  it("truncates characters beyond the cap instead of failing the draft", () => {
    const value = candidateWithCharacters();
    value.characters = Array.from({ length: 12 }, (_, index) => ({
      ...value.characters[0],
      id: `char_${index}`,
    }));
    const draft = validateLayoutDraftCandidate(value, source);

    expect(draft.characters).toHaveLength(8);
  });

  it("skips characters that collide with component ids", () => {
    const value = candidateWithCharacters();
    value.characters[0] = { ...value.characters[0], id: "wall_01" };
    const draft = validateLayoutDraftCandidate(value, source);

    expect(draft.characters).toHaveLength(1);
    expect(draft.characters[0].id).toBe("char_02");
  });

  it("scales character positions and heights together with components during calibration", () => {
    const draft = validateLayoutDraftCandidate(candidateWithCharacters(), source, { draftId: "draft_chars" });
    const calibrated = calibrateLayoutDraft(draft, "wall_01", 3);

    expect(calibrated.scale.mode).toBe("anchored");
    expect(calibrated.characters[0].height).toBeCloseTo(0.85);
    expect(calibrated.characters[0].position).toEqual([0.6, 0, 0.2]);
    expect(calibrated.characters[1].position).toEqual([0.1, 0.225, -0.05]);
    // 原草稿不被修改
    expect(draft.characters[0].height).toBe(1.7);
  });
});
