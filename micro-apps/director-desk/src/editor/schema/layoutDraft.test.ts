import { describe, expect, it } from "vitest";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import { getUE4GroundedLabelY } from "../runtime/ue4Mannequin/ue4MannequinRig";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "./viewportLabels";
import {
  buildLayoutBatch,
  calibrateLayoutDraft,
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

    // 坐姿人物：位置直接落在座面高度上，姿态走坐姿预设，素体按体型提示选择
    expect(sitting).toMatchObject({
      kind: "character",
      bodyType: "female",
      characterRig: { posePresetId: "sit" },
      layoutSource: { category: "character", characterMeta: { posture: "sit", height: 1.62 } },
    });
    expect(sitting.transform.position).toEqual([0.2, 0.45, -0.1]);
    expect(sitting.transform.scale[0]).toBeCloseTo(1.62 / LAYOUT_CHARACTER_NATIVE_HEIGHT);
  });

  it("maps every posture onto an existing pose preset", () => {
    LAYOUT_CHARACTER_POSTURES.forEach((posture) => {
      const presetId = LAYOUT_POSTURE_TO_POSE_PRESET[posture];
      expect(MANNEQUIN_POSE_PRESETS.some((preset) => preset.id === presetId)).toBe(true);
    });
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
