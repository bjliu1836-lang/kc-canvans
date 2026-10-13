/**
 * 参考图人物识别的全链路回归：
 * 模拟视觉模型返回的 JSON → 服务端同规则校验 → 客户端解析 → 尺度校准 →
 * 生成对象 → 应用进场景 → 批次变换。
 *
 * 重点验证用户的核心诉求：人物与场景/道具的比例关系在整条链路里保持一致，
 * 且人物身高在锚定校准后是绝对正确的米制值。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { getUE4SeatedPelvisSupportHeight } from "../runtime/ue4Mannequin/ue4MannequinRig";
import {
  buildLayoutBatch,
  calibrateLayoutDraft,
  LAYOUT_CHARACTER_NATIVE_HEIGHT,
  validateLayoutDraftCandidate,
} from "./layoutDraft";

/** 模拟一张"两人坐在沙发上"的参考图的模型输出（未经服务端/客户端加工）。 */
function modelResponse() {
  return {
    scale: { mode: "estimated", confidence: 0.4 },
    components: [
      {
        id: "ground_01", name: "地面", category: "ground", primitive: "box",
        position: [0, 0, 0], size: [5, 0.1, 4], rotationYDegrees: 0, confidence: 0.9, uncertain: false,
      },
      {
        id: "wall_01", name: "后墙", category: "wall", primitive: "box",
        position: [0, 0, -2], size: [5, 2.7, 0.12], rotationYDegrees: 0, confidence: 0.85, uncertain: false,
      },
      {
        id: "sofa_01", name: "双人沙发", category: "sofa", primitive: "box",
        position: [0, 0, 0], size: [2.1, 0.85, 0.9], rotationYDegrees: 0, confidence: 0.8, uncertain: false,
      },
      {
        id: "table_01", name: "茶几", category: "table", primitive: "box",
        position: [0, 0, 1.1], size: [1.1, 0.42, 0.6], rotationYDegrees: 0, confidence: 0.7, uncertain: false,
      },
    ],
    characters: [
      {
        id: "char_01", name: "人物甲", position: [-0.55, 0.45, 0.1],
        height: 1.72, rotationYDegrees: 12, posture: "sit", bodyTypeHint: "male",
        confidence: 0.75, uncertain: false, notes: "坐在沙发左侧",
      },
      {
        id: "char_02", name: "人物乙", position: [0.6, 0.45, 0.1],
        height: 1.65, rotationYDegrees: -15, posture: "sit", bodyTypeHint: "female",
        confidence: 0.7, uncertain: false, notes: "坐在沙发右侧",
      },
    ],
  };
}

const source = { sourceId: "image_sofa", fileName: "客厅.png" };

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => storage.delete(key),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  useDirectorStore.getState().openScopedScene(null);
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    clipboard: [],
    clipboardPasteCount: 0,
    undoStack: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
  });
});

describe("参考图人物识别全链路", () => {
  it("解析模型输出并同时保留布景组件与人物", () => {
    const draft = validateLayoutDraftCandidate(modelResponse(), source);

    expect(draft.components).toHaveLength(4);
    expect(draft.characters).toHaveLength(2);
    expect(draft.characters[0].posture).toBe("sit");
    expect(draft.characters[0].height).toBe(1.72);
    // 坐姿人物的 Y 是座面高度，不是地面
    expect(draft.characters[0].position[1]).toBe(0.45);
  });

  it("比例关系：人物身高与家具尺寸处于同一把尺的合理量级", () => {
    const draft = validateLayoutDraftCandidate(modelResponse(), source);
    const sofa = draft.components.find((component) => component.category === "sofa")!;
    const table = draft.components.find((component) => component.category === "table")!;
    const person = draft.characters[0]!;

    // 双人沙发宽约 2 米，应略大于一个成年人的身高
    expect(sofa.size[0]).toBeGreaterThan(person.height);
    expect(sofa.size[0]).toBeLessThan(person.height * 1.6);
    // 茶几高 0.42 米应明显低于人（不到膝上才算合理）
    expect(table.size[1]).toBeLessThan(person.height * 0.35);
    // 房间必须高过人：层高 > 身高
    expect(draft.components.find((component) => component.category === "wall")!.size[1])
      .toBeGreaterThan(person.height);
    // 人物不能被缩到跟道具一个量级：任一件家具的最小维度都不该超过人的身高
    const furniture = draft.components.filter(
      (component) => component.category !== "ground" && component.category !== "wall"
    );
    expect(Math.max(...furniture.map((component) => Math.min(...component.size)))).toBeLessThan(person.height);
    // 身高落在成年人合理区间
    expect(person.height).toBeGreaterThan(1.4);
    expect(person.height).toBeLessThan(2);
  });

  it("尺度校准后人物与布景同比缩放，身高变为绝对米制值", () => {
    const draft = validateLayoutDraftCandidate(modelResponse(), source);
    const beforeSofa = draft.components.find((component) => component.category === "sofa")!;
    const beforePerson = draft.characters[0]!;
    const beforeRatio = beforePerson.height / beforeSofa.size[0];

    // 用户锚定"沙发宽 2 米"
    const calibrated = calibrateLayoutDraft(draft, beforeSofa.id, 2, "width");
    const afterSofa = calibrated.components.find((component) => component.category === "sofa")!;
    const afterPerson = calibrated.characters[0]!;

    expect(afterSofa.size[0]).toBeCloseTo(2);
    // 相对比例守恒
    expect(afterPerson.height / afterSofa.size[0]).toBeCloseTo(beforeRatio);
    // 身高同步缩放（原 1.72 在沙发 2.1→2 的缩放因子下略减）
    expect(afterPerson.height).toBeCloseTo(1.72 * (2 / 2.1));
    // 应用时按 height/NATIVE 换算，模型缩放到位后世界高度即该米数
    const scaleFactor = afterPerson.height / LAYOUT_CHARACTER_NATIVE_HEIGHT;
    expect(scaleFactor * LAYOUT_CHARACTER_NATIVE_HEIGHT).toBeCloseTo(afterPerson.height);
  });

  it("应用进场景后人物与手动添加的角色同权，且整批贴地不会把坐姿人物拉下沙发", () => {
    const draft = validateLayoutDraftCandidate(modelResponse(), source);
    const { batchId } = useDirectorStore.getState().applyLayoutDraft({ draft, mode: "append" });
    const objects = () => useDirectorStore.getState().project.objects
      .filter((object) => object.layoutSource?.batchId === batchId);
    const characters = () => objects().filter((object) => object.kind === "character");

    expect(objects()).toHaveLength(6); // 4 布景 + 2 人物
    expect(characters()).toHaveLength(2);

    const first = characters()[0]!;
    expect(first.layoutSource?.category).toBe("character");
    expect(first.transform.scale[0]).toBeCloseTo(1.72 / LAYOUT_CHARACTER_NATIVE_HEIGHT);
    expect(first.transform.position[1] + getUE4SeatedPelvisSupportHeight("mannequin") * first.transform.scale[1])
      .toBeCloseTo(0.45);
    expect(first.characterRig?.posePresetId).toBe("sit");

    // 整批贴地：坐姿人物的骨盆座面锚点保持在 0.45m，站立的布景正常落地
    useDirectorStore.getState().transformLayoutBatch(batchId, { snapToGround: true });
    const sittingAfterSnap = characters()[0]!;
    expect(
      sittingAfterSnap.transform.position[1]
      + getUE4SeatedPelvisSupportHeight("mannequin") * sittingAfterSnap.transform.scale[1],
    ).toBeCloseTo(0.45);
  });

  it("无人物时向后兼容：旧格式（只有 components）依然产出纯布景批次", () => {
    const legacy = modelResponse();
    delete (legacy as Partial<ReturnType<typeof modelResponse>>).characters;
    const draft = validateLayoutDraftCandidate(legacy, source);
    const built = buildLayoutBatch(draft, "layout_legacy", [], 0);

    expect(draft.characters).toEqual([]);
    expect(built.objects).toHaveLength(4);
    expect(built.objects.every((object) => object.kind === "prop")).toBe(true);
  });
});
