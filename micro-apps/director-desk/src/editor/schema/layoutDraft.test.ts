import { describe, expect, it } from "vitest";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import {
  getUE4GroundedLabelY,
  getUE4SeatedPelvisSupportHeight,
} from "../runtime/ue4Mannequin/ue4MannequinRig";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "./viewportLabels";
import templeCurrentModelDraft from "./__fixtures__/temple-current-model-draft.json";
import {
  buildLayoutBatch,
  calibrateLayoutDraft,
  createLayoutCharacterRenderAdapter,
  getLayoutCharacterCanonicalHeight,
  getLayoutComponentRenderPosition,
  LAYOUT_CATEGORY_COLORS,
  LAYOUT_CHARACTER_COLOR,
  LAYOUT_CHARACTER_NATIVE_HEIGHT,
  LAYOUT_CHARACTER_POSTURES,
  LAYOUT_POSTURE_TO_POSE_PRESET,
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

  it("keeps preview and apply ground placement identical for the real temple response", () => {
    const draft = validateLayoutDraftCandidate(templeCurrentModelDraft, source, { draftId: "temple_real_raw" });
    const ground = draft.components.find((component) => component.id === "ground_01")!;
    const previewPosition = getLayoutComponentRenderPosition(ground, 0);
    const built = buildLayoutBatch(draft, "temple_real_raw", [], 0);
    const appliedGround = built.objects.find((object) => object.layoutSource?.componentId === "ground_01")!;

    expect(ground.position[1]).toBe(-0.05);
    expect(previewPosition).toEqual([0, -0.1, 0]);
    expect(appliedGround.transform.position).toEqual(previewPosition);
    expect(previewPosition[1] + ground.size[1]).toBeCloseTo(0);
  });

  it("surfaces mixed center/bottom Y semantics from the real temple response without flattening valid props", () => {
    const draft = validateLayoutDraftCandidate(templeCurrentModelDraft, source, { draftId: "temple_diagnostics" });
    const backWall = draft.components.find((component) => component.id === "wall_back_01")!;
    const vase = draft.components.find((component) => component.id === "prop_vase_01")!;
    const character = draft.characters[0];

    expect(backWall.position[1]).toBe(1.5);
    expect(backWall.uncertain).toBe(true);
    expect(backWall.notes).toContain("可能是合法悬空墙段/台上柱，也可能误用了几何中心 Y");
    expect(vase.position[1]).toBe(1.15);
    expect(character.position[1]).toBe(0.12);
    expect(character.uncertain).toBe(true);
    expect(character.notes).toContain("prop_cushion_01 顶面 Y=0.18 不一致");

    const revalidated = validateLayoutDraftCandidate(draft, source, { draftId: "temple_diagnostics_again" });
    expect(revalidated.components.find((component) => component.id === "wall_back_01")!.notes!.match(/误用了几何中心 Y/g)).toHaveLength(1);
    expect(revalidated.components.find((component) => component.id === "wall_back_01")!.notes!.length).toBeLessThanOrEqual(240);
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
    expect(draft.characters[0].position[1]).toBe(0.12);
    expect(farProp.position[1]).toBe(0.4);
    expect(farProp.uncertain).toBe(true);
    expect(farProp.notes).toContain("水平足迹不重叠");
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
