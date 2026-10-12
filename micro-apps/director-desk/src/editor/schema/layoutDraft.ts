import type {
  CharacterBodyType,
  DirectorLayoutBatch,
  DirectorLayoutCategory,
  DirectorObject,
  GeometryPrimitiveType,
} from "./directorProject";

export const LAYOUT_DRAFT_MAX_COMPONENTS = 30;
export const LAYOUT_COMPONENT_CATEGORIES = [
  "ground",
  "wall",
  "door",
  "window",
  "table",
  "chair",
  "sofa",
  "cabinet",
] as const satisfies readonly DirectorLayoutCategory[];

export const LAYOUT_COMPONENT_PRIMITIVES = ["box", "cylinder"] as const satisfies readonly GeometryPrimitiveType[];

/* ------------------------------------------------------------------ */
/* 人物占位（参考图识别的第二类产物）                                   */
/* ------------------------------------------------------------------ */

export const LAYOUT_CHARACTER_MAX_COUNT = 8;
export const LAYOUT_CHARACTER_MIN_HEIGHT = 0.5;
export const LAYOUT_CHARACTER_MAX_HEIGHT = 2.5;

export const LAYOUT_CHARACTER_POSTURES = ["stand", "sit", "crouch", "kneel", "lie", "unknown"] as const;
export type LayoutCharacterPosture = (typeof LAYOUT_CHARACTER_POSTURES)[number];

export const LAYOUT_CHARACTER_BODY_HINTS = ["male", "female", "unknown"] as const;
export type LayoutCharacterBodyHint = (typeof LAYOUT_CHARACTER_BODY_HINTS)[number];

/** 姿态 → 现有姿态预设（mannequinPosePresets）的映射。 */
export const LAYOUT_POSTURE_TO_POSE_PRESET: Record<LayoutCharacterPosture, string> = {
  stand: "stand",
  sit: "sit",
  crouch: "crouch",
  kneel: "kneel-one",
  // 姿态预设暂无躺姿，映射为站立并要求调用方标记 uncertain
  lie: "stand",
  unknown: "stand",
};

/** 体型提示 → 内置素体。只决定素体外形，不做脸部/服装还原。 */
export const LAYOUT_BODY_HINT_TO_BODY_TYPE: Record<LayoutCharacterBodyHint, CharacterBodyType> = {
  male: "mannequin",
  female: "female",
  unknown: "mannequin",
};

/**
 * 默认角色素体（rigType "ue4-mannequin"，transform.scale = 1）的世界高度（米）。
 * 与视口标签锚点同源：getUE4GroundedLabelY("mannequin") - VIEWPORT_OBJECT_LABEL_VERTICAL_GAP
 * = 2.04 - 0.18 ≈ 1.86。layoutDraft.test.ts 有同步断言，标签锚点调整时此值随之失效并报错。
 * 注意：UE4 模型加载失败回退到程序化素体时实际高度不同，该边缘场景接受偏差。
 */
export const LAYOUT_CHARACTER_NATIVE_HEIGHT = 1.86;

/** 角色占位统一使用默认角色蓝，与手动添加的角色一致。 */
export const LAYOUT_CHARACTER_COLOR = "#4F8EF7";

export interface LayoutDraftCharacter {
  id: string;
  name: string;
  /** 身体与支撑面的接触中心：站立/蹲姿=脚底，坐姿=臀部在座面上的投影点；Y 即支撑面高度（地面 0，沙发约 0.45）。 */
  position: [number, number, number];
  /** 估算身高（与组件同单位；校准后为米）。 */
  height: number;
  rotationYDegrees: number;
  posture: LayoutCharacterPosture;
  bodyTypeHint: LayoutCharacterBodyHint;
  confidence: number;
  uncertain: boolean;
  notes?: string;
  visible: boolean;
}

export type LayoutAnchorDimension = "width" | "height";

/** 各类组件的常见真实尺寸，用于尺度校正时预填，降低用户估算门槛。 */
export const LAYOUT_ANCHOR_PRESETS: Record<DirectorLayoutCategory, {
  dimension: LayoutAnchorDimension;
  meters: number;
  hint: string;
}> = {
  ground: { dimension: "width", meters: 4, hint: "房间开间" },
  wall: { dimension: "height", meters: 2.8, hint: "层高" },
  door: { dimension: "height", meters: 2.05, hint: "标准门高" },
  window: { dimension: "height", meters: 1.5, hint: "窗体高度" },
  table: { dimension: "height", meters: 0.75, hint: "标准桌高" },
  chair: { dimension: "height", meters: 0.9, hint: "椅背高度" },
  sofa: { dimension: "width", meters: 2, hint: "双人沙发宽" },
  cabinet: { dimension: "height", meters: 1.8, hint: "柜体高度" },
};

/** 各类组件的语义配色，预览与应用后保持一致，帮助用户分辨谁是谁。 */
export const LAYOUT_CATEGORY_COLORS: Record<DirectorLayoutCategory, string> = {
  ground: "#7A8494",
  wall: "#8FA3C4",
  door: "#C9A06C",
  window: "#7FD4E8",
  table: "#B98A5E",
  chair: "#D4A6A0",
  sofa: "#6F9E8F",
  cabinet: "#A88BB5",
};

export interface LayoutBatchTransformPatch {
  /** 以布景中心为基准的整体缩放倍数，1 表示不变。 */
  scaleFactor?: number;
  /** 沿 X 轴整体平移（米）。 */
  offsetX?: number;
  /** 沿 Z 轴整体平移（米）。 */
  offsetZ?: number;
  /** 把批次内所有悬浮组件的底面贴到地面（地面组件自身除外）。 */
  snapToGround?: boolean;
}

export interface LayoutDraftComponent {
  id: string;
  name: string;
  category: DirectorLayoutCategory;
  primitive: Extract<GeometryPrimitiveType, "box" | "cylinder">;
  /** Bottom-center position in scene metres. */
  position: [number, number, number];
  /** Width, height and depth in scene metres. */
  size: [number, number, number];
  rotationYDegrees: number;
  confidence: number;
  uncertain: boolean;
  notes?: string;
  visible: boolean;
}

export interface LayoutDraft {
  version: 1;
  id: string;
  sourceId: string;
  sourceFileName: string;
  createdAt: string;
  scale: {
    mode: "estimated" | "anchored";
    confidence: number;
    anchorComponentId?: string;
    anchorWidthMeters?: number;
    anchorDimension?: LayoutAnchorDimension;
  };
  components: LayoutDraftComponent[];
  /** 参考图识别到的人物占位；旧数据/纯布景图为空数组。 */
  characters: LayoutDraftCharacter[];
}

export interface LayoutDraftSource {
  sourceId: string;
  fileName: string;
}

export interface ApplyLayoutDraftInput {
  draft: LayoutDraft;
  mode: "append" | "replace-batch";
  replaceBatchId?: string | null;
}

export interface ApplyLayoutDraftResult {
  batchId: string;
  objectIds: string[];
}

export class LayoutDraftValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] ?? "布局数据无效");
    this.name = "LayoutDraftValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTuple3(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function boundedString(value: unknown, fallback: string, maxLength = 80) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function parseJsonCandidate(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(withoutFence) as unknown;
}

function normalizeHalfTurnDifference(left: number, right: number) {
  const difference = Math.abs(((left - right + 90) % 180 + 180) % 180 - 90);
  return difference;
}

function clampLayoutCharacterHeight(value: number) {
  return Math.min(LAYOUT_CHARACTER_MAX_HEIGHT, Math.max(LAYOUT_CHARACTER_MIN_HEIGHT, value));
}

/**
 * 规范化单个候选人物；结构非法（非对象/缺 id）返回 null 由调用方跳过，
 * 取值范围外的数值做夹紧并标记 uncertain（单人数据问题不阻断整张草稿）。
 */
function normalizeLayoutCharacter(raw: unknown, index: number, seenIds: Set<string>): LayoutDraftCharacter | null {
  const label = `第 ${index + 1} 个人物`;
  if (!isRecord(raw)) return null;

  const baseId = boundedString(raw.id, `char_${String(index + 1).padStart(2, "0")}`, 48)
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!baseId) return null;
  if (seenIds.has(baseId)) return null;
  seenIds.add(baseId);

  const position: [number, number, number] = isFiniteTuple3(raw.position)
    ? [...raw.position] as [number, number, number]
    : [0, 0, 0];
  const clampedPosition: [number, number, number] = [
    Math.min(100, Math.max(-100, position[0])),
    Math.min(5, Math.max(-1, position[1])),
    Math.min(100, Math.max(-100, position[2])),
  ];

  const rawHeight = typeof raw.height === "number" && Number.isFinite(raw.height)
    ? raw.height
    : LAYOUT_CHARACTER_NATIVE_HEIGHT;
  const height = clampLayoutCharacterHeight(rawHeight);

  const rawPosture = raw.posture;
  const posture: LayoutCharacterPosture = LAYOUT_CHARACTER_POSTURES.includes(rawPosture as LayoutCharacterPosture)
    ? rawPosture as LayoutCharacterPosture
    : "unknown";

  const rawBodyHint = raw.bodyTypeHint;
  const bodyTypeHint: LayoutCharacterBodyHint = LAYOUT_CHARACTER_BODY_HINTS.includes(rawBodyHint as LayoutCharacterBodyHint)
    ? rawBodyHint as LayoutCharacterBodyHint
    : "unknown";

  const rotationYDegrees = typeof raw.rotationYDegrees === "number" && Number.isFinite(raw.rotationYDegrees)
    ? raw.rotationYDegrees
    : 0;
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0.4;

  const positionWasInvalid = !isFiniteTuple3(raw.position);
  const heightWasOutOfRange = rawHeight < LAYOUT_CHARACTER_MIN_HEIGHT || rawHeight > LAYOUT_CHARACTER_MAX_HEIGHT;
  const postureWasUnknown = posture === "unknown" || posture === "lie";

  return {
    id: baseId,
    name: boundedString(raw.name, `人物${index + 1}`),
    position: clampedPosition,
    height,
    rotationYDegrees,
    posture,
    bodyTypeHint,
    confidence,
    uncertain: raw.uncertain === true
      || confidence < 0.65
      || positionWasInvalid
      || heightWasOutOfRange
      || postureWasUnknown,
    notes: [
      boundedString(raw.notes, "", 240),
      positionWasInvalid ? "位置缺失，已置于原点" : "",
      heightWasOutOfRange ? `身高已夹紧到 ${height} 米` : "",
      posture === "lie" ? "卧姿暂用站立占位，请手动调整" : "",
    ].filter(Boolean).join("；") || undefined,
    visible: raw.visible !== false,
  };
}

function carveDoorOpenings(components: LayoutDraftComponent[]) {
  const doors = components.filter((component) => component.category === "door" && component.primitive === "box");
  if (!doors.length) return components;
  const result: LayoutDraftComponent[] = [];

  for (const component of components) {
    if (component.category !== "wall" || component.primitive !== "box") {
      result.push(component);
      continue;
    }
    const angle = component.rotationYDegrees * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const wallHalfWidth = component.size[0] / 2;
    const door = doors.find((candidate) => {
      if (normalizeHalfTurnDifference(candidate.rotationYDegrees, component.rotationYDegrees) > 18) return false;
      const dx = candidate.position[0] - component.position[0];
      const dz = candidate.position[2] - component.position[2];
      const localX = cos * dx - sin * dz;
      const localZ = sin * dx + cos * dz;
      return Math.abs(localZ) <= (component.size[2] + candidate.size[2]) / 2 + 0.12
        && localX - candidate.size[0] / 2 > -wallHalfWidth
        && localX + candidate.size[0] / 2 < wallHalfWidth
        && candidate.position[1] <= component.position[1] + 0.2
        && candidate.size[1] < component.size[1] - 0.05;
    });
    if (!door || result.length + (components.length - result.length) + 2 > LAYOUT_DRAFT_MAX_COMPONENTS) {
      result.push(component);
      continue;
    }

    const dx = door.position[0] - component.position[0];
    const dz = door.position[2] - component.position[2];
    const localDoorX = cos * dx - sin * dz;
    const doorLeft = localDoorX - door.size[0] / 2;
    const doorRight = localDoorX + door.size[0] / 2;
    const segments: Array<{ suffix: string; name: string; localX: number; width: number; y: number; height: number }> = [];
    const leftWidth = doorLeft + wallHalfWidth;
    const rightWidth = wallHalfWidth - doorRight;
    const topHeight = component.size[1] - door.size[1];
    if (leftWidth > 0.05) segments.push({ suffix: "left", name: "左段", localX: -wallHalfWidth + leftWidth / 2, width: leftWidth, y: component.position[1], height: component.size[1] });
    if (rightWidth > 0.05) segments.push({ suffix: "right", name: "右段", localX: doorRight + rightWidth / 2, width: rightWidth, y: component.position[1], height: component.size[1] });
    if (topHeight > 0.05) segments.push({ suffix: "top", name: "门楣", localX: localDoorX, width: door.size[0], y: component.position[1] + door.size[1], height: topHeight });

    segments.forEach((segment) => {
      result.push({
        ...component,
        id: `${component.id}_${segment.suffix}`,
        name: `${component.name}·${segment.name}`,
        position: [
          component.position[0] + cos * segment.localX,
          segment.y,
          component.position[2] - sin * segment.localX,
        ],
        size: [segment.width, segment.height, component.size[2]],
        notes: [component.notes, "已为识别到的门保留通道"].filter(Boolean).join("；"),
      });
    });
  }
  return result;
}

export function validateLayoutDraftCandidate(
  candidate: unknown,
  source: LayoutDraftSource,
  options: { draftId?: string; createdAt?: string } = {}
): LayoutDraft {
  let parsed: unknown;
  try {
    parsed = parseJsonCandidate(candidate);
  } catch {
    throw new LayoutDraftValidationError(["模型没有返回可解析的 JSON"]);
  }

  if (!isRecord(parsed)) throw new LayoutDraftValidationError(["布局结果必须是 JSON 对象"]);
  const rawComponents = parsed.components;
  if (!Array.isArray(rawComponents)) throw new LayoutDraftValidationError(["布局结果缺少 components 数组"]);
  if (rawComponents.length === 0) throw new LayoutDraftValidationError(["没有识别到可用的粗布景组件"]);
  if (rawComponents.length > LAYOUT_DRAFT_MAX_COMPONENTS) {
    throw new LayoutDraftValidationError([`组件数量超过 ${LAYOUT_DRAFT_MAX_COMPONENTS} 个上限`]);
  }

  const issues: string[] = [];
  const seenIds = new Set<string>();
  const components = rawComponents.map((raw, index): LayoutDraftComponent | null => {
    const label = `第 ${index + 1} 个组件`;
    if (!isRecord(raw)) {
      issues.push(`${label}不是对象`);
      return null;
    }
    const category = raw.category;
    const primitive = raw.primitive;
    if (!LAYOUT_COMPONENT_CATEGORIES.includes(category as DirectorLayoutCategory)) {
      issues.push(`${label}包含未知类型 ${String(category)}`);
    }
    if (!LAYOUT_COMPONENT_PRIMITIVES.includes(primitive as "box" | "cylinder")) {
      issues.push(`${label}包含未知基础资产 ${String(primitive)}`);
    }
    if (!isFiniteTuple3(raw.position)) issues.push(`${label}的位置必须是三个有限数字`);
    if (!isFiniteTuple3(raw.size)) {
      issues.push(`${label}的尺寸必须是三个有限数字`);
    } else if (raw.size.some((item) => item <= 0 || item > 100)) {
      issues.push(`${label}的尺寸必须大于 0 且不超过 100 米`);
    }
    const rotationYDegrees = raw.rotationYDegrees;
    if (typeof rotationYDegrees !== "number" || !Number.isFinite(rotationYDegrees)) {
      issues.push(`${label}的朝向必须是有限数字`);
    }
    const confidence = raw.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      issues.push(`${label}的置信度必须在 0 到 1 之间`);
    }

    const baseId = boundedString(raw.id, `item_${String(index + 1).padStart(2, "0")}`, 48)
      .replace(/[^a-zA-Z0-9_-]/g, "_");
    const id = baseId || `item_${String(index + 1).padStart(2, "0")}`;
    if (seenIds.has(id)) issues.push(`${label}的 id 重复`);
    seenIds.add(id);

    if (
      !LAYOUT_COMPONENT_CATEGORIES.includes(category as DirectorLayoutCategory)
      || !LAYOUT_COMPONENT_PRIMITIVES.includes(primitive as "box" | "cylinder")
      || !isFiniteTuple3(raw.position)
      || !isFiniteTuple3(raw.size)
      || raw.size.some((item) => item <= 0 || item > 100)
      || typeof rotationYDegrees !== "number"
      || !Number.isFinite(rotationYDegrees)
      || typeof confidence !== "number"
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
    ) return null;

    return {
      id,
      name: boundedString(raw.name, `组件${index + 1}`),
      category: category as DirectorLayoutCategory,
      primitive: primitive as "box" | "cylinder",
      position: [...raw.position] as [number, number, number],
      size: [...raw.size] as [number, number, number],
      rotationYDegrees,
      confidence,
      uncertain: raw.uncertain === true || confidence < 0.65,
      notes: boundedString(raw.notes, "", 240) || undefined,
      visible: raw.visible !== false,
    };
  });

  if (issues.length) throw new LayoutDraftValidationError(issues);

  const rawScale = isRecord(parsed.scale) ? parsed.scale : {};
  const scaleConfidence = typeof rawScale.confidence === "number"
    && Number.isFinite(rawScale.confidence)
    && rawScale.confidence >= 0
    && rawScale.confidence <= 1
      ? rawScale.confidence
      : 0.35;

  const normalizedComponents = components.filter((item): item is LayoutDraftComponent => Boolean(item));

  // 人物解析：缺省为空数组（纯布景图合法）；超过上限截断而非报错；
  // 单个结构非法的人物跳过，取值范围外夹紧并标记 uncertain。
  const rawCharacters = Array.isArray(parsed.characters) ? parsed.characters.slice(0, LAYOUT_CHARACTER_MAX_COUNT) : [];
  const characters = rawCharacters
    .map((raw, index) => normalizeLayoutCharacter(raw, index, seenIds))
    .filter((item): item is LayoutDraftCharacter => Boolean(item));

  return {
    version: 1,
    id: options.draftId ?? `draft_${Date.now().toString(36)}`,
    sourceId: boundedString(source.sourceId, "local-reference", 128),
    sourceFileName: boundedString(source.fileName, "参考图", 160),
    createdAt: options.createdAt ?? new Date().toISOString(),
    scale: {
      mode: "estimated",
      confidence: scaleConfidence,
    },
    components: carveDoorOpenings(normalizedComponents),
    characters,
  };
}

export function calibrateLayoutDraft(
  draft: LayoutDraft,
  componentId: string,
  anchorMeters: number,
  dimension: LayoutAnchorDimension = "width"
): LayoutDraft {
  if (!Number.isFinite(anchorMeters) || anchorMeters <= 0 || anchorMeters > 100) {
    throw new LayoutDraftValidationError(["已知尺寸必须大于 0 且不超过 100 米"]);
  }
  const anchor = draft.components.find((component) => component.id === componentId);
  if (!anchor) throw new LayoutDraftValidationError(["请选择仍在草稿中的组件作为尺寸锚点"]);
  const axisIndex = dimension === "height" ? 1 : 0;
  const factor = anchorMeters / anchor.size[axisIndex];
  if (!Number.isFinite(factor) || factor <= 0) throw new LayoutDraftValidationError(["无法使用该组件校正尺寸"]);

  return {
    ...draft,
    scale: {
      mode: "anchored",
      confidence: 1,
      anchorComponentId: componentId,
      anchorWidthMeters: anchorMeters,
      anchorDimension: dimension,
    },
    components: draft.components.map((component) => ({
      ...component,
      position: component.position.map((value) => value * factor) as [number, number, number],
      size: component.size.map((value) => value * factor) as [number, number, number],
    })),
    // 人物与组件同一把尺：位置与身高同步缩放，校准后相对比例保持
    characters: draft.characters.map((character) => ({
      ...character,
      position: character.position.map((value) => value * factor) as [number, number, number],
      height: character.height * factor,
    })),
  };
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56) || "item";
}

function uniqueId(base: string, used: Set<string>) {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  used.add(id);
  return id;
}

export function buildLayoutBatch(
  draft: LayoutDraft,
  batchId: string,
  existingObjectIds: readonly string[],
  groundHeight = 0
): { batch: DirectorLayoutBatch; objects: DirectorObject[] } {
  const usedIds = new Set(existingObjectIds);
  const objects = draft.components.map((component) => {
    const id = uniqueId(`${sanitizeId(batchId)}_${sanitizeId(component.id)}`, usedIds);
    return {
      id,
      name: component.name,
      kind: "prop" as const,
      visible: component.visible,
      locked: false,
      geometryType: component.primitive,
      color: LAYOUT_CATEGORY_COLORS[component.category],
      transform: {
        position: component.category === "ground"
          ? [component.position[0], groundHeight - component.size[1], component.position[2]]
          : [...component.position] as [number, number, number],
        rotation: [0, component.rotationYDegrees * Math.PI / 180, 0] as [number, number, number],
        scale: [...component.size] as [number, number, number],
      },
      layoutSource: {
        batchId,
        draftId: draft.id,
        sourceId: draft.sourceId,
        sourceFileName: draft.sourceFileName,
        componentId: component.id,
        category: component.category,
        confidence: component.confidence,
        uncertain: component.uncertain,
      },
    } satisfies DirectorObject;
  });

  // 人物占位：按估算身高换算素体缩放（scale=height/NATIVE），与手动添加的角色同权
  const characterObjects = draft.characters.map((character) => {
    const id = uniqueId(`${sanitizeId(batchId)}_${sanitizeId(character.id)}`, usedIds);
    const scaleFactor = character.height / LAYOUT_CHARACTER_NATIVE_HEIGHT;
    return {
      id,
      name: character.name,
      kind: "character" as const,
      visible: character.visible,
      locked: false,
      bodyType: LAYOUT_BODY_HINT_TO_BODY_TYPE[character.bodyTypeHint],
      color: LAYOUT_CHARACTER_COLOR,
      transform: {
        position: [...character.position] as [number, number, number],
        rotation: [0, character.rotationYDegrees * Math.PI / 180, 0] as [number, number, number],
        scale: [scaleFactor, scaleFactor, scaleFactor] as [number, number, number],
      },
      characterRig: {
        rigType: "ue4-mannequin" as const,
        posePresetId: LAYOUT_POSTURE_TO_POSE_PRESET[character.posture],
        controls: {},
      },
      layoutSource: {
        batchId,
        draftId: draft.id,
        sourceId: draft.sourceId,
        sourceFileName: draft.sourceFileName,
        componentId: character.id,
        category: "character" as const,
        confidence: character.confidence,
        uncertain: character.uncertain,
        characterMeta: {
          posture: character.posture,
          height: character.height,
        },
      },
    } satisfies DirectorObject;
  });

  const allObjects = [...objects, ...characterObjects];

  return {
    objects: allObjects,
    batch: {
      id: batchId,
      draftId: draft.id,
      sourceId: draft.sourceId,
      sourceFileName: draft.sourceFileName,
      createdAt: draft.createdAt,
      scale: { ...draft.scale },
      objectIds: allObjects.map((object) => object.id),
    },
  };
}
