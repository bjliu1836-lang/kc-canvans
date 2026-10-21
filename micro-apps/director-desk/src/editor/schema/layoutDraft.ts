import type {
  CharacterBodyType,
  DirectorLayoutBatch,
  DirectorLayoutCategory,
  DirectorLayoutReferenceCamera,
  DirectorObject,
  GeometryPrimitiveType,
} from "./directorProject";
import { resolveLayoutSemanticProfile } from "./layoutSemanticProfiles";
import { deriveObservedAssemblyPrisms, getDefaultLayoutCategoryAssembly, getLayoutAssemblyUnitBoundsTransform } from "../canvas/layoutGeometryBounds";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import {
  getUE4GroundedLabelY,
  getUE4SeatedPelvisSupportHeight,
} from "../runtime/ue4Mannequin/ue4MannequinRig";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "./viewportLabels";
import { LAYOUT_CATALOG_FIT_MODE, resolveLayoutComponentRepresentation } from "./layoutComponentRepresentation";

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
  "pillar",
  "prop",
] as const satisfies readonly DirectorLayoutCategory[];

export const LAYOUT_COMPONENT_PRIMITIVES = ["box", "cylinder"] as const satisfies readonly GeometryPrimitiveType[];
export const LAYOUT_SPACE_TYPES = ["enclosed", "open", "outdoor", "unknown"] as const;
export type LayoutSpaceType = (typeof LAYOUT_SPACE_TYPES)[number];
export const LAYOUT_OBSERVATION_STATES = ["visible", "occluded", "cropped", "ambiguous"] as const;
export type LayoutObservationState = (typeof LAYOUT_OBSERVATION_STATES)[number];
export const LAYOUT_RELATION_TYPES = [
  "attached_to",
  "adjacent_to",
  "supports",
  "head_at",
  "parallel_to",
  "faces",
  "left_of",
  "right_of",
] as const;
export type LayoutRelationType = (typeof LAYOUT_RELATION_TYPES)[number];

/* ------------------------------------------------------------------ */
/* 人物占位（参考图识别的第二类产物）                                   */
/* ------------------------------------------------------------------ */

export const LAYOUT_CHARACTER_MAX_COUNT = 8;
export const LAYOUT_CHARACTER_MIN_HEIGHT = 0.5;
export const LAYOUT_CHARACTER_MAX_HEIGHT = 2.5;

export const LAYOUT_CHARACTER_POSTURES = ["stand", "sit", "crouch", "kneel", "lie", "unknown"] as const;
export type LayoutCharacterPosture = (typeof LAYOUT_CHARACTER_POSTURES)[number];

export const LAYOUT_KNEEL_VARIANTS = ["one-knee", "two-knee", "seiza"] as const;
export type LayoutKneelVariant = (typeof LAYOUT_KNEEL_VARIANTS)[number];

export const LAYOUT_HAND_GESTURES = ["prayer"] as const;
export type LayoutHandGesture = (typeof LAYOUT_HAND_GESTURES)[number];

export const LAYOUT_CHARACTER_BODY_HINTS = ["male", "female", "unknown"] as const;
export type LayoutCharacterBodyHint = (typeof LAYOUT_CHARACTER_BODY_HINTS)[number];
export const LAYOUT_CHARACTER_FACING_DIRECTIONS = ["image_left", "image_right", "toward_camera", "away_from_camera", "unknown", "image_up", "image_down"] as const;
export type LayoutCharacterFacingDirection = (typeof LAYOUT_CHARACTER_FACING_DIRECTIONS)[number];

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
export const LAYOUT_CHARACTER_NATIVE_HEIGHT = getUE4GroundedLabelY("mannequin") - VIEWPORT_OBJECT_LABEL_VERTICAL_GAP;

export function getLayoutCharacterCanonicalHeight(bodyType: CharacterBodyType) {
  return getUE4GroundedLabelY(bodyType) - VIEWPORT_OBJECT_LABEL_VERTICAL_GAP;
}

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
  /** Source-image facing evidence; image_up/down remain accepted for previously saved drafts. */
  facingDirection?: LayoutCharacterFacingDirection;
  posture: LayoutCharacterPosture;
  /** 跪姿细分；旧草稿没有该字段时继续沿用历史的单膝跪映射。 */
  kneelVariant?: LayoutKneelVariant;
  /** 当前只细分可可靠表达的合十手势；未提供时沿用姿态预设的中性手臂。 */
  handGesture?: LayoutHandGesture;
  /** 明确承载人物的组件 id；存在时人物 Y 由该组件顶面计算。 */
  supportComponentId?: string;
  bodyTypeHint: LayoutCharacterBodyHint;
  confidence: number;
  uncertain: boolean;
  notes?: string;
  visible: boolean;
}

export type LayoutAnchorDimension = "width" | "height";

/** 各类组件的尺度锚点建议；差异过大的类别不预填米数，避免误校准整场。 */
export const LAYOUT_ANCHOR_PRESETS: Record<DirectorLayoutCategory, {
  dimension: LayoutAnchorDimension;
  meters?: number;
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
  pillar: { dimension: "height", hint: "柱体高度差异较大" },
  prop: { dimension: "height", hint: "道具可能是坐垫、供器或雕像，尺寸差异较大" },
};

/** 中性占位材质色；只有 appearance.color 明确存在时才表达识别出的颜色。 */
export const LAYOUT_CATEGORY_COLORS: Record<DirectorLayoutCategory, string> = {
  ground: "#92979D",
  wall: "#92979D",
  door: "#92979D",
  window: "#92979D",
  table: "#92979D",
  chair: "#92979D",
  sofa: "#92979D",
  cabinet: "#92979D",
  pillar: "#92979D",
  prop: "#92979D",
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
  /** 明确承载该组件重量的另一组件 id；存在时底面 Y 由支撑组件顶面计算。 */
  supportComponentId?: string;
  /** Parent component whose local-space motion should carry this separate observed part. */
  partOfComponentId?: string;
  rotationYDegrees: number;
  confidence: number;
  uncertain: boolean;
  /** 可编辑的受限语义描述，用于选择已有程序构件或本地库，绝不承诺生成新模型。 */
  modelDescriptor?: string;
  /** 扩展语义标签，不影响旧 category/geometry；例如 bed、bookshelf、curtain。 */
  semanticType?: string;
  appearance?: {
    color?: string;
    roughness?: number;
    metalness?: number;
    /** 局部 +Z 正面在世界中的方向，缺省时使用 rotationYDegrees。 */
    frontDirectionDegrees?: number;
  };
  /** 受限声明式子部件，局部坐标和尺寸均相对组件包围盒（0..1）；最多 24 个。 */
  assembly?: Array<{
    primitive: "box" | "cylinder" | "sphere" | "cone" | "torus";
    position: [number, number, number];
    size: [number, number, number];
    rotation?: [number, number, number];
    opacity?: number;
  }>;
  /** Observed planar occupancy only; this never implies a solid full-height render volume. */
  groundFootprint?: Array<{
    outer: [number, number][];
    holes?: [number, number][][];
    confidence: number;
  }>;
  /** Safe image-space crop evidence for an explicitly confirmed single-object generation input. */
  sourceImageEvidence?: {
    bbox: [number, number, number, number];
    confidence: number;
    visibility: "visible" | "partial" | "occluded" | "uncertain";
    sourceId?: string;
    hasPartComponents?: boolean;
  };
  /** Local asset registered from the confirmed single-object result; never a provider URL or capability. */
  generatedAssetRefId?: string;
  generatedAssetNeedsReview?: boolean;
  generatedAssetState?: "generating" | "ready" | "failed";
  generatedAssetUnavailable?: boolean;
  notes?: string;
  visible: boolean;
}

export function getLayoutComponentAssembly(component: Pick<LayoutDraftComponent, "assembly" | "category" | "name" | "modelDescriptor" | "primitive">) {
  return component.assembly ?? getDefaultLayoutCategoryAssembly(component.category, `${component.name} ${component.modelDescriptor ?? ""}`, component.primitive);
}

export interface LayoutDraft {
  version: 1;
  id: string;
  /** Client-only trace association; excluded from generated DirectorProject objects. */
  diagnosticGenerationId?: string;
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
  /** 参考图的透视起始机位；无可信输入时由布局边界生成并明确标为自动取景。 */
  referenceCamera?: DirectorLayoutReferenceCamera;
  /** 旧 Draft 缺省为 unknown；仅描述可见/不确定证据，不替代几何。 */
  spaceType?: LayoutSpaceType;
  observations?: Array<{
    componentId?: string;
    state: LayoutObservationState;
    confidence: number;
    evidence?: string;
  }>;
  /** 关系 ID 引用同一 Draft 的组件；left/right 始终按原图语义视角。 */
  relations?: Array<{
    fromId: string;
    toId: string;
    type: LayoutRelationType;
    confidence: number;
  }>;
  /** 仅包含可安全展示的本地校验提示码，不保存模型原文或图片内容。 */
  validationWarnings?: string[];
  components: LayoutDraftComponent[];
  /** 参考图识别到的人物占位；旧数据/纯布景图为空数组。 */
  characters: LayoutDraftCharacter[];
}

/** Merge a registered local asset into the latest draft without reverting concurrent layout edits. */
export function bindGeneratedAssetToLayoutDraft(draft: LayoutDraft, componentId: string, assetRefId: string): LayoutDraft | null {
  if (!assetRefId || !draft.components.some((component) => component.id === componentId)) return null;
  return {
    ...draft,
    components: draft.components.map((component) => component.id === componentId ? {
      ...component,
      generatedAssetRefId: assetRefId,
      generatedAssetNeedsReview: true,
      generatedAssetState: undefined,
      generatedAssetUnavailable: undefined,
      uncertain: true,
    } : component),
  };
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

function normalizeLayoutAppearance(raw: unknown, fallbackDirection: number): LayoutDraftComponent["appearance"] {
  if (!isRecord(raw)) return undefined;
  const color = typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color.trim())
    ? raw.color.trim().toUpperCase()
    : undefined;
  const roughness = typeof raw.roughness === "number" && Number.isFinite(raw.roughness)
    ? Math.min(1, Math.max(0, raw.roughness))
    : undefined;
  const metalness = typeof raw.metalness === "number" && Number.isFinite(raw.metalness)
    ? Math.min(1, Math.max(0, raw.metalness))
    : undefined;
  const frontDirectionDegrees = typeof raw.frontDirectionDegrees === "number" && Number.isFinite(raw.frontDirectionDegrees)
    ? raw.frontDirectionDegrees
    : fallbackDirection;
  return color || roughness !== undefined || metalness !== undefined || frontDirectionDegrees !== fallbackDirection
    ? { ...(color ? { color } : {}), ...(roughness !== undefined ? { roughness } : {}), ...(metalness !== undefined ? { metalness } : {}), frontDirectionDegrees }
    : undefined;
}

function normalizeLayoutAssembly(raw: unknown): LayoutDraftComponent["assembly"] {
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set(["box", "cylinder", "sphere", "cone", "torus"]);
  if (raw.length > 24 || raw.length === 0) return undefined;
  const parts = raw.map((part) => {
    if (!isRecord(part) || !allowed.has(String(part.primitive)) || !isFiniteTuple3(part.position) || !isFiniteTuple3(part.size)) return [];
    const position = part.position;
    const size = part.size;
    if (position.some((value) => value < 0 || value > 1) || size.some((value) => value <= 0 || value > 1)
      || position.some((value, index) => value - size[index] / 2 < 0 || value + size[index] / 2 > 1)) return [];
    const rotation = isFiniteTuple3(part.rotation) && part.rotation.every((value) => Math.abs(value) <= 360)
      ? [...part.rotation] as [number, number, number]
      : undefined;
    const [rx, ry, rz] = (rotation ?? [0, 0, 0]).map((value) => value * Math.PI / 180);
    const sx = Math.sin(rx), cx = Math.cos(rx), sy = Math.sin(ry), cy = Math.cos(ry), sz = Math.sin(rz), cz = Math.cos(rz);
    const matrix = [
      [cy * cz, -cy * sz, sy],
      [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
      [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy],
    ];
    const half = matrix.map((row) => row.reduce((sum, value, axis) => sum + Math.abs(value) * size[axis] / 2, 0));
    if (position.some((value, axis) => value - half[axis] < 0 || value + half[axis] > 1)) return [];
    const opacity = typeof part.opacity === "number" && Number.isFinite(part.opacity) && part.opacity >= 0.15 && part.opacity <= 1
      ? part.opacity
      : undefined;
    if (part.opacity !== undefined && opacity === undefined) return [];
    return [{ primitive: part.primitive as "box" | "cylinder" | "sphere" | "cone" | "torus", position: [...position] as [number, number, number], size: [...size] as [number, number, number], ...(rotation ? { rotation } : {}), ...(opacity !== undefined ? { opacity } : {}) }];
  });
  return parts.length === raw.length && parts.every((part) => part.length === 1) ? parts.flat() : undefined;
}

function normalizeGroundFootprint(raw: unknown): LayoutDraftComponent["groundFootprint"] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) return undefined;
  const normalizeLoop = (loop: unknown, min: number, max: number): [number, number][] | undefined => {
    if (!Array.isArray(loop) || loop.length < min || loop.length > max) return undefined;
    const points = loop.map((point) => Array.isArray(point) && point.length === 2
      && point.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
      ? [point[0], point[1]] as [number, number] : undefined);
    return points.every((point): point is [number, number] => Boolean(point)) ? points as [number, number][] : undefined;
  };
  const result = raw.map((part) => {
    if (!isRecord(part) || typeof part.confidence !== "number" || !Number.isFinite(part.confidence) || part.confidence < 0 || part.confidence > 1) return undefined;
    const outer = normalizeLoop(part.outer, 3, 16);
    const holesRaw = part.holes === undefined ? [] : part.holes;
    if (!outer || !Array.isArray(holesRaw) || holesRaw.length > 2) return undefined;
    const holes = holesRaw.map((hole) => normalizeLoop(hole, 3, 12));
    if (holes.some((hole) => !hole)) return undefined;
    return { outer, ...(holes.length ? { holes: holes as [number, number][][] } : {}), confidence: part.confidence };
  });
  return result.every((part) => Boolean(part)) ? result as NonNullable<LayoutDraftComponent["groundFootprint"]> : undefined;
}

function buildSemanticLayoutAssembly(semanticType: string | undefined): LayoutDraftComponent["assembly"] {
  const shape = (
    primitive: "box" | "cylinder" | "sphere" | "cone" | "torus",
    position: [number, number, number],
    size: [number, number, number],
    opacity?: number,
  ): NonNullable<LayoutDraftComponent["assembly"]>[number] => ({
    primitive,
    position,
    size,
    ...(opacity !== undefined ? { opacity } : {}),
  });
  const box = (position: [number, number, number], size: [number, number, number], opacity?: number) => ({
    primitive: "box" as const,
    position,
    size,
    ...(opacity !== undefined ? { opacity } : {}),
  });
  if (semanticType === "bed") {
    return [
      box([0.5, 0.08, 0.5], [0.98, 0.14, 0.92]),
      box([0.5, 0.31, 0.5], [0.94, 0.34, 0.86]),
      box([0.5, 0.72, 0.08], [0.98, 0.54, 0.08]),
      box([0.31, 0.55, 0.2], [0.28, 0.1, 0.22]),
      box([0.69, 0.55, 0.2], [0.28, 0.1, 0.22]),
    ];
  }
  if (semanticType === "curtain") {
    return [
      box([0.5, 0.96, 0.5], [0.98, 0.035, 0.06]),
      box([0.17, 0.5, 0.5], [0.26, 0.92, 0.045]),
      box([0.83, 0.5, 0.5], [0.26, 0.92, 0.045]),
      box([0.5, 0.5, 0.52], [0.48, 0.9, 0.02], 0.35),
    ];
  }
  if (semanticType === "bookshelf") {
    return [
      box([0.05, 0.5, 0.5], [0.08, 0.98, 0.92]),
      box([0.95, 0.5, 0.5], [0.08, 0.98, 0.92]),
      ...[0.05, 0.275, 0.5, 0.725, 0.95].map((y) => box([0.5, y, 0.5], [0.84, 0.05, 0.88])),
    ];
  }
  if (semanticType === "table") {
    return [
      box([0.5, 0.91, 0.5], [0.98, 0.12, 0.92]),
      box([0.5, 0.78, 0.08], [0.82, 0.12, 0.12]),
      box([0.5, 0.78, 0.92], [0.82, 0.12, 0.12]),
      box([0.08, 0.78, 0.5], [0.12, 0.12, 0.76]),
      box([0.92, 0.78, 0.5], [0.12, 0.12, 0.76]),
      ...[0.1, 0.9].flatMap((x) => [0.1, 0.9].map((z) => box([x, 0.4, z], [0.11, 0.72, 0.11]))),
    ];
  }
  if (semanticType === "nightstand") {
    return [
      box([0.5, 0.92, 0.5], [0.98, 0.12, 0.92]),
      box([0.5, 0.08, 0.5], [0.9, 0.1, 0.84]),
      box([0.07, 0.5, 0.5], [0.1, 0.82, 0.84]),
      box([0.93, 0.5, 0.5], [0.1, 0.82, 0.84]),
      box([0.5, 0.5, 0.08], [0.82, 0.82, 0.08]),
      box([0.5, 0.57, 0.92], [0.78, 0.34, 0.045]),
      box([0.5, 0.17, 0.92], [0.78, 0.34, 0.045]),
    ];
  }
  if (semanticType === "cabinet") {
    return [
      box([0.05, 0.5, 0.5], [0.1, 0.98, 0.9]),
      box([0.95, 0.5, 0.5], [0.1, 0.98, 0.9]),
      box([0.5, 0.05, 0.5], [0.82, 0.1, 0.9]),
      box([0.5, 0.95, 0.5], [0.82, 0.1, 0.9]),
      box([0.5, 0.5, 0.06], [0.82, 0.8, 0.08]),
      box([0.29, 0.5, 0.92], [0.39, 0.8, 0.045]),
      box([0.71, 0.5, 0.92], [0.39, 0.8, 0.045]),
      box([0.5, 0.5, 0.95], [0.02, 0.8, 0.03]),
      box([0.49, 0.5, 0.98], [0.025, 0.08, 0.02]),
      box([0.51, 0.5, 0.98], [0.025, 0.08, 0.02]),
    ];
  }
  if (semanticType === "sculpture") {
    return [
      shape("cylinder", [0.5, 0.08, 0.5], [0.72, 0.16, 0.72]),
      shape("sphere", [0.5, 0.33, 0.5], [0.58, 0.38, 0.5]),
      shape("sphere", [0.5, 0.58, 0.5], [0.86, 0.26, 0.68]),
      shape("sphere", [0.5, 0.8, 0.5], [0.48, 0.34, 0.44]),
      box([0.5, 0.98, 0.5], [0.7, 0.04, 0.58]),
    ];
  }
  if (semanticType === "plant") {
    return [
      shape("cylinder", [0.5, 0.12, 0.5], [0.48, 0.24, 0.48]),
      shape("cylinder", [0.5, 0.48, 0.5], [0.09, 0.5, 0.09]),
      shape("sphere", [0.5, 0.68, 0.5], [0.52, 0.48, 0.52]),
      shape("sphere", [0.32, 0.73, 0.52], [0.42, 0.36, 0.42]),
      shape("sphere", [0.68, 0.73, 0.48], [0.42, 0.36, 0.42]),
      shape("sphere", [0.5, 0.88, 0.5], [0.4, 0.24, 0.4]),
    ];
  }
  if (semanticType === "pillow") {
    return [
      shape("sphere", [0.5, 0.5, 0.5], [0.9, 0.72, 0.9]),
      box([0.5, 0.5, 0.96], [0.72, 0.045, 0.025], 0.8),
    ];
  }
  if (semanticType === "blanket") {
    return [
      box([0.5, 0.18, 0.5], [0.98, 0.28, 0.94]),
      box([0.5, 0.56, 0.93], [0.98, 0.54, 0.12]),
      box([0.5, 0.91, 0.82], [0.98, 0.18, 0.2]),
    ];
  }
  if (semanticType === "container") {
    return [
      shape("cylinder", [0.5, 0.06, 0.5], [0.42, 0.12, 0.42]),
      shape("sphere", [0.5, 0.39, 0.5], [0.76, 0.62, 0.76]),
      shape("cylinder", [0.5, 0.78, 0.5], [0.35, 0.24, 0.35]),
      shape("torus", [0.5, 0.94, 0.5], [0.42, 0.06, 0.42]),
    ];
  }
  if (semanticType === "candlestick") {
    return [
      shape("cylinder", [0.5, 0.06, 0.5], [0.72, 0.12, 0.72]),
      shape("cylinder", [0.5, 0.48, 0.5], [0.2, 0.72, 0.2]),
      shape("cylinder", [0.5, 0.86, 0.5], [0.52, 0.08, 0.52]),
      shape("cylinder", [0.5, 0.92, 0.5], [0.16, 0.14, 0.16]),
    ];
  }
  if (semanticType === "lantern") {
    return [
      box([0.5, 0.5, 0.5], [0.66, 0.58, 0.66], 0.3),
      ...[0.17, 0.83].flatMap((x) => [0.17, 0.83].map((z) => box([x, 0.5, z], [0.07, 0.72, 0.07]))),
      box([0.5, 0.11, 0.5], [0.86, 0.1, 0.86]),
      shape("cone", [0.5, 0.87, 0.5], [0.92, 0.24, 0.92]),
      shape("torus", [0.5, 0.98, 0.5], [0.24, 0.04, 0.24]),
    ];
  }
  if (semanticType === "table_lamp") {
    return [
      shape("cylinder", [0.5, 0.06, 0.5], [0.62, 0.12, 0.62]),
      shape("cylinder", [0.5, 0.45, 0.5], [0.14, 0.68, 0.14]),
      shape("cone", [0.5, 0.82, 0.5], [0.84, 0.34, 0.84]),
      shape("sphere", [0.5, 0.98, 0.5], [0.1, 0.04, 0.1]),
    ];
  }
  if (semanticType === "ceiling_lamp") {
    return [
      shape("torus", [0.5, 0.96, 0.5], [0.64, 0.06, 0.64]),
      shape("cylinder", [0.5, 0.76, 0.5], [0.12, 0.4, 0.12]),
      shape("cone", [0.5, 0.35, 0.5], [0.9, 0.56, 0.9]),
      shape("sphere", [0.5, 0.08, 0.5], [0.14, 0.16, 0.14]),
    ];
  }
  return undefined;
}

function parseJsonCandidate(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(withoutFence) as unknown;
}

function getLayoutReferenceCameraFallback(components: readonly LayoutDraftComponent[], imageAspectRatio?: number): DirectorLayoutReferenceCamera {
  const bounds = components.reduce(
    (current, component) => ({
      minX: Math.min(current.minX, component.position[0] - component.size[0] / 2),
      maxX: Math.max(current.maxX, component.position[0] + component.size[0] / 2),
      minY: Math.min(current.minY, component.position[1]),
      maxY: Math.max(current.maxY, component.position[1] + component.size[1]),
      minZ: Math.min(current.minZ, component.position[2] - component.size[2] / 2),
      maxZ: Math.max(current.maxZ, component.position[2] + component.size[2] / 2),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity },
  );
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const depth = Math.max(1, bounds.maxZ - bounds.minZ);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const target: [number, number, number] = [
    (bounds.minX + bounds.maxX) / 2,
    bounds.minY + height * 0.48,
    (bounds.minZ + bounds.maxZ) / 2,
  ];
  return {
    projection: "perspective",
    position: [target[0], target[1] + Math.max(0.7, height * 0.22), bounds.maxZ + Math.max(width, depth) * 1.15],
    target,
    fov: 50,
    confidence: 0,
    source: "bounds-fallback",
    ...(imageAspectRatio ? { imageAspectRatio } : {}),
  };
}

function normalizeLayoutReferenceCamera(raw: unknown, components: readonly LayoutDraftComponent[], imageAspectRatio?: number): DirectorLayoutReferenceCamera {
  if (!isRecord(raw) || !isFiniteTuple3(raw.position) || !isFiniteTuple3(raw.target)
    || typeof raw.fov !== "number" || !Number.isFinite(raw.fov) || raw.fov < 20 || raw.fov > 100) {
    return getLayoutReferenceCameraFallback(components, imageAspectRatio);
  }
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;
  const rawFit = isRecord(raw.fitDiagnostics) ? raw.fitDiagnostics : undefined;
  const rawSpatialTrace = rawFit && isRecord(rawFit.spatialEvidenceTrace) ? rawFit.spatialEvidenceTrace : undefined;
  const spatialIds = (value: unknown) => Array.isArray(value) && value.length <= 32
    && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 48) ? value as string[] : undefined;
  const rawRefinementSearch = rawSpatialTrace && isRecord(rawSpatialTrace.selectedRefinementSearch) ? rawSpatialTrace.selectedRefinementSearch : undefined;
  const refinementSearchBasis = ["visible-footprint-fixed", "visible-center-contact-fixed", "visible-center-contact-bounded", "observed-bbox-center-bounded", "low-confidence-bbox-center-bounded"];
  const selectedRefinementSearch = rawRefinementSearch
    && ["evaluationBudget", "evaluationCount", "feasibleEvaluationCount", "acceptedMoves", "completedScaleLevels"].every((key) => Number.isInteger(rawRefinementSearch[key]) && Number(rawRefinementSearch[key]) >= 0 && Number(rawRefinementSearch[key]) <= 600)
    && typeof rawRefinementSearch.budgetExhausted === "boolean"
    && Array.isArray(rawRefinementSearch.positionEvidence) && rawRefinementSearch.positionEvidence.length <= 32
    && rawRefinementSearch.positionEvidence.every((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 48
      && refinementSearchBasis.includes(String(entry.basis)) && typeof entry.fixed === "boolean"
      && typeof entry.maxDeltaMeters === "number" && Number.isFinite(entry.maxDeltaMeters) && entry.maxDeltaMeters >= 0 && entry.maxDeltaMeters <= 100)
    ? {
      evaluationBudget: Number(rawRefinementSearch.evaluationBudget),
      evaluationCount: Number(rawRefinementSearch.evaluationCount),
      feasibleEvaluationCount: Number(rawRefinementSearch.feasibleEvaluationCount),
      acceptedMoves: Number(rawRefinementSearch.acceptedMoves),
      completedScaleLevels: Number(rawRefinementSearch.completedScaleLevels),
      budgetExhausted: rawRefinementSearch.budgetExhausted,
      positionEvidence: rawRefinementSearch.positionEvidence.map((entry) => ({
        id: String(entry.id), basis: String(entry.basis) as "visible-footprint-fixed" | "visible-center-contact-fixed" | "visible-center-contact-bounded" | "observed-bbox-center-bounded" | "low-confidence-bbox-center-bounded",
        fixed: entry.fixed as boolean, maxDeltaMeters: Number(entry.maxDeltaMeters),
      })),
    }
    : undefined;
  const spatialEvidenceTrace = rawSpatialTrace
    && ["footprint", "joint", "none"].includes(String(rawSpatialTrace.selectedBranch))
    && spatialIds(rawSpatialTrace.sourceFootprintIds)
    && spatialIds(rawSpatialTrace.eligiblePairIds)
    && spatialIds(rawSpatialTrace.initializedFootprintIds)
    && spatialIds(rawSpatialTrace.selectedInitializedIds)
    && spatialIds(rawSpatialTrace.selectedAfterCarryIds)
    && spatialIds(rawSpatialTrace.returnedByFitIds)
    && Number.isInteger(rawSpatialTrace.uniqueCameraCandidateCount) && Number(rawSpatialTrace.uniqueCameraCandidateCount) >= 0 && Number(rawSpatialTrace.uniqueCameraCandidateCount) <= 600
    && Number.isInteger(rawSpatialTrace.initializedCameraCandidateCount) && Number(rawSpatialTrace.initializedCameraCandidateCount) >= 0 && Number(rawSpatialTrace.initializedCameraCandidateCount) <= 600
    && Number.isInteger(rawSpatialTrace.safetyCheckedFootprintCandidateCount) && Number(rawSpatialTrace.safetyCheckedFootprintCandidateCount) >= 0 && Number(rawSpatialTrace.safetyCheckedFootprintCandidateCount) <= 600
    && (rawSpatialTrace.preselectionSafeFootprintCandidateCount === undefined || (Number.isInteger(rawSpatialTrace.preselectionSafeFootprintCandidateCount) && Number(rawSpatialTrace.preselectionSafeFootprintCandidateCount) >= 0 && Number(rawSpatialTrace.preselectionSafeFootprintCandidateCount) <= 600))
    && (rawSpatialTrace.postSelectionFootprintCandidateCount === undefined || (Number.isInteger(rawSpatialTrace.postSelectionFootprintCandidateCount) && Number(rawSpatialTrace.postSelectionFootprintCandidateCount) >= 0 && Number(rawSpatialTrace.postSelectionFootprintCandidateCount) <= 600))
    && (rawSpatialTrace.targetSafeFootprintCandidateCount === undefined || (Number.isInteger(rawSpatialTrace.targetSafeFootprintCandidateCount) && Number(rawSpatialTrace.targetSafeFootprintCandidateCount) >= 0 && Number(rawSpatialTrace.targetSafeFootprintCandidateCount) <= 600))
    && (rawSpatialTrace.safetyCheckStoppedEarly === undefined || typeof rawSpatialTrace.safetyCheckStoppedEarly === "boolean")
    && Array.isArray(rawSpatialTrace.failedInitializationById) && rawSpatialTrace.failedInitializationById.length <= 32
    && rawSpatialTrace.failedInitializationById.every((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 48
      && Number.isInteger(entry.cameraCount) && Number(entry.cameraCount) >= 0 && Number(entry.cameraCount) <= 600)
    && Number.isInteger(rawSpatialTrace.footprintOverlapRejectedCandidateCount) && Number(rawSpatialTrace.footprintOverlapRejectedCandidateCount) >= 0 && Number(rawSpatialTrace.footprintOverlapRejectedCandidateCount) <= 600
    && Array.isArray(rawSpatialTrace.majorOverlapRejects) && rawSpatialTrace.majorOverlapRejects.length <= 32
    && rawSpatialTrace.majorOverlapRejects.every((entry) => isRecord(entry) && typeof entry.firstId === "string" && entry.firstId.length > 0 && entry.firstId.length <= 48
      && typeof entry.secondId === "string" && entry.secondId.length > 0 && entry.secondId.length <= 48
      && Number.isInteger(entry.candidateCount) && Number(entry.candidateCount) >= 0 && Number(entry.candidateCount) <= 600
      && typeof entry.maxPenetrationMeters === "number" && Number.isFinite(entry.maxPenetrationMeters) && entry.maxPenetrationMeters >= 0 && entry.maxPenetrationMeters <= 100)
    ? {
      selectedBranch: rawSpatialTrace.selectedBranch as "footprint" | "joint" | "none",
      sourceFootprintIds: spatialIds(rawSpatialTrace.sourceFootprintIds)!,
      eligiblePairIds: spatialIds(rawSpatialTrace.eligiblePairIds)!,
      uniqueCameraCandidateCount: Number(rawSpatialTrace.uniqueCameraCandidateCount),
      initializedCameraCandidateCount: Number(rawSpatialTrace.initializedCameraCandidateCount),
      initializedFootprintIds: spatialIds(rawSpatialTrace.initializedFootprintIds)!,
      safetyCheckedFootprintCandidateCount: Number(rawSpatialTrace.safetyCheckedFootprintCandidateCount),
      ...(rawSpatialTrace.preselectionSafeFootprintCandidateCount !== undefined ? { preselectionSafeFootprintCandidateCount: Number(rawSpatialTrace.preselectionSafeFootprintCandidateCount) } : {}),
      ...(rawSpatialTrace.postSelectionFootprintCandidateCount !== undefined ? { postSelectionFootprintCandidateCount: Number(rawSpatialTrace.postSelectionFootprintCandidateCount) } : {}),
      ...(rawSpatialTrace.targetSafeFootprintCandidateCount !== undefined ? { targetSafeFootprintCandidateCount: Number(rawSpatialTrace.targetSafeFootprintCandidateCount) } : {}),
      ...(rawSpatialTrace.safetyCheckStoppedEarly !== undefined ? { safetyCheckStoppedEarly: rawSpatialTrace.safetyCheckStoppedEarly } : {}),
      failedInitializationById: rawSpatialTrace.failedInitializationById.map((entry) => ({ id: String(entry.id), cameraCount: Number(entry.cameraCount) })),
      footprintOverlapRejectedCandidateCount: Number(rawSpatialTrace.footprintOverlapRejectedCandidateCount),
      majorOverlapRejects: rawSpatialTrace.majorOverlapRejects.map((entry) => ({ firstId: String(entry.firstId), secondId: String(entry.secondId), candidateCount: Number(entry.candidateCount), maxPenetrationMeters: Number(entry.maxPenetrationMeters) })),
      ...(selectedRefinementSearch ? { selectedRefinementSearch } : rawSpatialTrace.selectedRefinementSearch === null ? { selectedRefinementSearch: null } : {}),
      selectedInitializedIds: spatialIds(rawSpatialTrace.selectedInitializedIds)!,
      selectedAfterCarryIds: spatialIds(rawSpatialTrace.selectedAfterCarryIds)!,
      returnedByFitIds: spatialIds(rawSpatialTrace.returnedByFitIds)!,
    }
    : undefined;
  const rawPostTransformSafety = rawFit && isRecord(rawFit.postTransformSafety) ? rawFit.postTransformSafety : undefined;
  const postTransformSafety = rawPostTransformSafety
    && spatialIds(rawPostTransformSafety.cameraInsideComponentIds)
    && typeof rawPostTransformSafety.alignmentRejected === "boolean"
    && Array.isArray(rawPostTransformSafety.newMajorOverlapPairs) && rawPostTransformSafety.newMajorOverlapPairs.length <= 32
    && rawPostTransformSafety.newMajorOverlapPairs.every((entry) => isRecord(entry)
      && typeof entry.firstId === "string" && entry.firstId.length > 0 && entry.firstId.length <= 48
      && typeof entry.secondId === "string" && entry.secondId.length > 0 && entry.secondId.length <= 48
      && ["hard", "review"].includes(String(entry.classification))
      && typeof entry.reason === "string" && entry.reason.length <= 96
      && typeof entry.penetrationMeters === "number" && Number.isFinite(entry.penetrationMeters) && entry.penetrationMeters >= 0 && entry.penetrationMeters <= 100)
    ? {
      newMajorOverlapPairs: rawPostTransformSafety.newMajorOverlapPairs.map((entry) => ({
        firstId: String(entry.firstId), secondId: String(entry.secondId),
        classification: entry.classification as "hard" | "review", reason: String(entry.reason), penetrationMeters: Number(entry.penetrationMeters),
      })),
      cameraInsideComponentIds: spatialIds(rawPostTransformSafety.cameraInsideComponentIds)!,
      alignmentRejected: rawPostTransformSafety.alignmentRejected,
    }
    : undefined;
  const rawPhysicalValidity = rawFit?.physicalValidity as Record<string, unknown> | undefined;
  const normalizeCollisionCounts = (value: unknown) => {
    if (!isRecord(value)) return undefined;
    const keys = ["totalCandidates", "hard", "review", "allowed"] as const;
    if (!keys.every((key) => Number.isInteger(Number(value[key])) && Number(value[key]) >= 0)) return undefined;
    return {
      totalCandidates: Number(value.totalCandidates),
      hard: Number(value.hard),
      review: Number(value.review),
      allowed: Number(value.allowed),
    };
  };
  const initialCollisionCounts = normalizeCollisionCounts(rawPhysicalValidity?.initialCollisionCounts);
  const finalCollisionCounts = normalizeCollisionCounts(rawPhysicalValidity?.finalCollisionCounts);
  const rawPairDiagnostics = rawFit && Array.isArray(rawFit.pairDiagnostics) ? rawFit.pairDiagnostics : undefined;
  const pairDiagnostics = rawPairDiagnostics?.slice(0, 32).flatMap((entry) => {
    const isTuple2 = (value: unknown, min: number, max: number): value is [number, number] => Array.isArray(value) && value.length === 2
      && value.every((item) => typeof item === "number" && Number.isFinite(item) && item >= min && item <= max);
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length > 48
      || !isTuple2(entry.observedCenter, -100, 100) || !isTuple2(entry.predictedCenter, -100, 100)
      || !isTuple2(entry.observedSize, 0.01, 100) || !isTuple2(entry.predictedSize, 0.01, 100)
      || typeof entry.centerError !== "number" || !Number.isFinite(entry.centerError) || entry.centerError < 0 || entry.centerError > 10
      || typeof entry.scaleError !== "number" || !Number.isFinite(entry.scaleError) || entry.scaleError < 0 || entry.scaleError > 20
      || typeof entry.weightedContribution !== "number" || !Number.isFinite(entry.weightedContribution) || entry.weightedContribution < 0 || entry.weightedContribution > 10) return [];
    return [{
      id: entry.id,
      observedCenter: [...entry.observedCenter] as [number, number],
      observedSize: [...entry.observedSize] as [number, number],
      predictedCenter: [...entry.predictedCenter] as [number, number],
      predictedSize: [...entry.predictedSize] as [number, number],
      centerError: entry.centerError,
      scaleError: entry.scaleError,
      weightedContribution: entry.weightedContribution,
    }];
  }).slice(0, 10);
  const rawBestCandidate = rawFit && isRecord(rawFit.bestCandidate) ? rawFit.bestCandidate : undefined;
  const bestCandidate = rawBestCandidate && isFiniteTuple3(rawBestCandidate.position) && isFiniteTuple3(rawBestCandidate.target)
    && Math.max(...rawBestCandidate.position.map(Math.abs)) <= 100
    && Math.max(...rawBestCandidate.target.map(Math.abs)) <= 100
    && typeof rawBestCandidate.fov === "number" && Number.isFinite(rawBestCandidate.fov) && rawBestCandidate.fov >= 20 && rawBestCandidate.fov <= 100
    ? { position: [...rawBestCandidate.position] as [number, number, number], target: [...rawBestCandidate.target] as [number, number, number], fov: rawBestCandidate.fov }
    : undefined;
  const fitDiagnostics = rawFit
    && (rawFit.qualityStatus === undefined || ["accepted", "needsReview", "unavailable"].includes(String(rawFit.qualityStatus)))
    && Number.isInteger(rawFit.itemCount) && Number(rawFit.itemCount) >= 0 && Number(rawFit.itemCount) <= 10
    && Number.isInteger(rawFit.candidateCount) && Number(rawFit.candidateCount) >= 0 && Number(rawFit.candidateCount) <= 600
    && typeof rawFit.applied === "boolean"
    && (rawFit.passedErrorThreshold === undefined || typeof rawFit.passedErrorThreshold === "boolean")
    && (rawFit.movedGroundItems === undefined || Number.isInteger(rawFit.movedGroundItems) && Number(rawFit.movedGroundItems) >= 0 && Number(rawFit.movedGroundItems) <= 10)
    && (rawFit.movedComponents === undefined || Number.isInteger(rawFit.movedComponents) && Number(rawFit.movedComponents) >= 0 && Number(rawFit.movedComponents) <= LAYOUT_DRAFT_MAX_COMPONENTS)
    && (rawFit.positionAdjustmentMeters === undefined || typeof rawFit.positionAdjustmentMeters === "number" && Number.isFinite(rawFit.positionAdjustmentMeters) && rawFit.positionAdjustmentMeters >= 0 && rawFit.positionAdjustmentMeters <= 100)
    && ([null, "insufficient-evidence", "no-safe-candidate", "insufficient-improvement", "error-too-high", "unsafe-collision"] as unknown[]).includes(rawFit.rejectionReason)
    && (rawFit.bestCandidate === null || Boolean(bestCandidate))
    && (rawFit.baselineProjectionError === null || typeof rawFit.baselineProjectionError === "number" && Number.isFinite(rawFit.baselineProjectionError) && rawFit.baselineProjectionError >= 0 && rawFit.baselineProjectionError <= 10)
    && (rawFit.bestProjectionError === null || typeof rawFit.bestProjectionError === "number" && Number.isFinite(rawFit.bestProjectionError) && rawFit.bestProjectionError >= 0 && rawFit.bestProjectionError <= 10)
    && (rawFit.cameraOnlyBestProjectionError === undefined || rawFit.cameraOnlyBestProjectionError === null || typeof rawFit.cameraOnlyBestProjectionError === "number" && Number.isFinite(rawFit.cameraOnlyBestProjectionError) && rawFit.cameraOnlyBestProjectionError >= 0 && rawFit.cameraOnlyBestProjectionError <= 10)
    && (rawFit.floorProjectionRejectedCandidateCount === undefined || Number.isInteger(rawFit.floorProjectionRejectedCandidateCount) && Number(rawFit.floorProjectionRejectedCandidateCount) >= 0 && Number(rawFit.floorProjectionRejectedCandidateCount) <= 600)
    && (rawFit.appliedProjectionError === undefined || rawFit.appliedProjectionError === null || typeof rawFit.appliedProjectionError === "number" && Number.isFinite(rawFit.appliedProjectionError) && rawFit.appliedProjectionError >= 0 && rawFit.appliedProjectionError <= 10)
    ? {
      qualityStatus: (rawFit.qualityStatus ?? (rawFit.applied ? "accepted" : "unavailable")) as "accepted" | "needsReview" | "unavailable",
      itemCount: Number(rawFit.itemCount),
      candidateCount: Number(rawFit.candidateCount),
      baselineProjectionError: rawFit.baselineProjectionError as number | null,
      bestProjectionError: rawFit.bestProjectionError as number | null,
      ...(rawFit.appliedProjectionError !== undefined ? { appliedProjectionError: rawFit.appliedProjectionError as number | null } : {}),
      ...(rawFit.cameraOnlyBestProjectionError !== undefined ? { cameraOnlyBestProjectionError: rawFit.cameraOnlyBestProjectionError as number | null } : {}),
      ...(rawFit.floorProjectionRejectedCandidateCount !== undefined ? { floorProjectionRejectedCandidateCount: Number(rawFit.floorProjectionRejectedCandidateCount) } : {}),
      ...(rawPairDiagnostics ? { pairDiagnostics: pairDiagnostics ?? [] } : {}),
      bestCandidate: bestCandidate ?? null,
      applied: rawFit.applied,
      ...(rawFit.passedErrorThreshold !== undefined ? { passedErrorThreshold: rawFit.passedErrorThreshold } : {}),
      ...(rawFit.movedGroundItems !== undefined ? { movedGroundItems: Number(rawFit.movedGroundItems) } : {}),
      ...(rawFit.movedComponents !== undefined ? { movedComponents: Number(rawFit.movedComponents) } : {}),
      ...(rawFit.positionAdjustmentMeters !== undefined ? { positionAdjustmentMeters: Number(rawFit.positionAdjustmentMeters) } : {}),
      ...(spatialEvidenceTrace ? { spatialEvidenceTrace } : {}),
      ...(postTransformSafety ? { postTransformSafety } : {}),
      ...(Array.isArray(rawFit.collisionPairs) ? {
        collisionPairs: rawFit.collisionPairs.slice(0, 32).flatMap((pair) => isRecord(pair)
          && typeof pair.firstId === "string" && pair.firstId.length <= 48
          && typeof pair.secondId === "string" && pair.secondId.length <= 48
          && ["hard", "review", "allowed"].includes(String(pair.classification))
          && typeof pair.reason === "string" && pair.reason.length <= 96
          ? [{ firstId: pair.firstId, secondId: pair.secondId, classification: pair.classification as "hard" | "review" | "allowed", reason: pair.reason }]
          : []),
      } : {}),
      ...(isRecord(rawFit.physicalValidity) && typeof rawFit.physicalValidity.withinRoom === "boolean"
        && typeof rawFit.physicalValidity.cameraOutsideGeometry === "boolean"
        && Number.isInteger(rawFit.physicalValidity.hardCollisionCount) && Number(rawFit.physicalValidity.hardCollisionCount) >= 0
        ? { physicalValidity: {
          withinRoom: rawFit.physicalValidity.withinRoom,
          ...(typeof rawFit.physicalValidity.roomBoundsEvaluated === "boolean" ? { roomBoundsEvaluated: rawFit.physicalValidity.roomBoundsEvaluated } : {}),
          cameraOutsideGeometry: rawFit.physicalValidity.cameraOutsideGeometry,
          ...(typeof rawFit.physicalValidity.cameraGeometryEvaluated === "boolean" ? { cameraGeometryEvaluated: rawFit.physicalValidity.cameraGeometryEvaluated } : {}),
          hardCollisionCount: Number(rawFit.physicalValidity.hardCollisionCount),
          ...(typeof rawFit.physicalValidity.initialPenetrationMeters === "number" && Number.isFinite(rawFit.physicalValidity.initialPenetrationMeters) && rawFit.physicalValidity.initialPenetrationMeters >= 0
            ? { initialPenetrationMeters: rawFit.physicalValidity.initialPenetrationMeters } : {}),
          ...(typeof rawFit.physicalValidity.finalPenetrationMeters === "number" && Number.isFinite(rawFit.physicalValidity.finalPenetrationMeters) && rawFit.physicalValidity.finalPenetrationMeters >= 0
            ? { finalPenetrationMeters: rawFit.physicalValidity.finalPenetrationMeters } : {}),
          ...(initialCollisionCounts ? { initialCollisionCounts } : {}),
          ...(finalCollisionCounts ? { finalCollisionCounts } : {}),
          ...(Array.isArray(rawFit.physicalValidity.roomBoundaryViolations) ? {
            roomBoundaryViolations: rawFit.physicalValidity.roomBoundaryViolations.slice(0, 32).flatMap((entry) => isRecord(entry)
              && typeof entry.componentId === "string" && entry.componentId.length <= 48
              && ["left", "right", "front", "back"].includes(String(entry.edge))
              && typeof entry.overflowMeters === "number" && Number.isFinite(entry.overflowMeters) && entry.overflowMeters >= 0
              ? [{ componentId: entry.componentId, edge: entry.edge as "left" | "right" | "front" | "back", overflowMeters: entry.overflowMeters }]
              : []),
          } : {}),
        } }
        : {}),
      rejectionReason: rawFit.rejectionReason as "insufficient-evidence" | "no-safe-candidate" | "insufficient-improvement" | "error-too-high" | "unsafe-collision" | null,
    }
    : undefined;
  return {
    projection: "perspective",
    position: [...raw.position] as [number, number, number],
    target: [...raw.target] as [number, number, number],
    fov: raw.fov,
    confidence,
    source: raw.source === "estimated" ? "estimated" : raw.source === "bounds-fallback" ? "bounds-fallback" : "model",
    ...(fitDiagnostics ? { fitDiagnostics } : {}),
    ...(imageAspectRatio ? { imageAspectRatio } : {}),
  };
}

/** 兼容在本地存储中的旧草稿；缺字段时明确返回自动取景，而不伪造模型相机。 */
export function getLayoutDraftReferenceCamera(draft: Pick<LayoutDraft, "referenceCamera" | "components">): DirectorLayoutReferenceCamera {
  return draft.referenceCamera ?? getLayoutReferenceCameraFallback(draft.components);
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
  const rawKneelVariant = raw.kneelVariant;
  const kneelVariant = posture === "kneel"
    && LAYOUT_KNEEL_VARIANTS.includes(rawKneelVariant as LayoutKneelVariant)
    ? rawKneelVariant as LayoutKneelVariant
    : undefined;
  const rawHandGesture = raw.handGesture;
  const handGesture = LAYOUT_HAND_GESTURES.includes(rawHandGesture as LayoutHandGesture)
    ? rawHandGesture as LayoutHandGesture
    : undefined;
  const supportComponentId = typeof raw.supportComponentId === "string"
    ? boundedString(raw.supportComponentId, "", 48).replace(/[^a-zA-Z0-9_-]/g, "_") || undefined
    : undefined;

  const rotationYDegrees = typeof raw.rotationYDegrees === "number" && Number.isFinite(raw.rotationYDegrees)
    ? raw.rotationYDegrees
    : 0;
  const facingDirection = LAYOUT_CHARACTER_FACING_DIRECTIONS.includes(raw.facingDirection as LayoutCharacterFacingDirection)
    ? raw.facingDirection as LayoutCharacterFacingDirection
    : undefined;
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
    ...(facingDirection ? { facingDirection } : {}),
    posture,
    kneelVariant,
    handGesture,
    ...(supportComponentId ? { supportComponentId } : {}),
    bodyTypeHint,
    confidence,
    uncertain: raw.uncertain === true
      || confidence < 0.65
      || positionWasInvalid
      || heightWasOutOfRange
      || postureWasUnknown
      || facingDirection === "unknown",
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
    const angle = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const wallRunsAlongX = component.size[0] >= component.size[2];
    const wallHalfLength = (wallRunsAlongX ? component.size[0] : component.size[2]) / 2;
    const door = doors.find((candidate) => {
      const expectedDoorYaw = getLayoutComponentRotationYDegrees(component) + (wallRunsAlongX ? 0 : 90);
      if (normalizeHalfTurnDifference(getLayoutComponentRotationYDegrees(candidate), expectedDoorYaw) > 18) return false;
      const dx = candidate.position[0] - component.position[0];
      const dz = candidate.position[2] - component.position[2];
      const localX = cos * dx - sin * dz;
      const localZ = sin * dx + cos * dz;
      const alongWall = wallRunsAlongX ? localX : localZ;
      const acrossWall = wallRunsAlongX ? localZ : localX;
      const wallThickness = wallRunsAlongX ? component.size[2] : component.size[0];
      return Math.abs(acrossWall) <= (wallThickness + candidate.size[2]) / 2 + 0.12
        && alongWall - candidate.size[0] / 2 > -wallHalfLength
        && alongWall + candidate.size[0] / 2 < wallHalfLength
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
    const localDoorZ = sin * dx + cos * dz;
    const localDoorAlongWall = wallRunsAlongX ? localDoorX : localDoorZ;
    const doorLeft = localDoorAlongWall - door.size[0] / 2;
    const doorRight = localDoorAlongWall + door.size[0] / 2;
    const segments: Array<{ suffix: string; name: string; along: number; width: number; y: number; height: number }> = [];
    const leftWidth = doorLeft + wallHalfLength;
    const rightWidth = wallHalfLength - doorRight;
    const topHeight = component.size[1] - door.size[1];
    if (leftWidth > 0.05) segments.push({ suffix: "left", name: "左段", along: -wallHalfLength + leftWidth / 2, width: leftWidth, y: component.position[1], height: component.size[1] });
    if (rightWidth > 0.05) segments.push({ suffix: "right", name: "右段", along: doorRight + rightWidth / 2, width: rightWidth, y: component.position[1], height: component.size[1] });
    if (topHeight > 0.05) segments.push({ suffix: "top", name: "门楣", along: localDoorAlongWall, width: door.size[0], y: component.position[1] + door.size[1], height: topHeight });

    segments.forEach((segment) => {
      result.push({
        ...component,
        id: `${component.id}_${segment.suffix}`,
        name: `${component.name}·${segment.name}`,
        position: wallRunsAlongX
          ? [component.position[0] + cos * segment.along, segment.y, component.position[2] - sin * segment.along]
          : [component.position[0] + sin * segment.along, segment.y, component.position[2] + cos * segment.along],
        size: wallRunsAlongX
          ? [segment.width, segment.height, component.size[2]]
          : [component.size[0], segment.height, segment.width],
        notes: [component.notes, "已为识别到的门保留通道"].filter(Boolean).join("；"),
      });
    });
  }
  return result;
}

const LAYOUT_SUPPORT_Y_TOLERANCE = 0.02;
const LAYOUT_LEGACY_SUPPORT_NEARBY_TOLERANCE = 0.15;

function appendLayoutDiagnostic(notes: string | undefined, diagnostic: string) {
  const current = (notes ?? "").trim().slice(0, 240);
  if (current.includes(diagnostic)) return current;
  if (diagnostic.length >= 240) return diagnostic.slice(0, 240);
  const prefix = current.slice(0, Math.max(0, 239 - diagnostic.length)).replace(/[；\s]+$/g, "");
  return prefix ? `${prefix}；${diagnostic}` : diagnostic;
}

function assemblySupportParts(component: LayoutDraftComponent) {
  const assembly = getLayoutComponentAssembly(component);
  const transform = getLayoutAssemblyUnitBoundsTransform(assembly);
  if (!transform || !assembly?.length) return [];
  const parts = assembly.flatMap((part) => {
    const width = part.size[0] * transform.scale[0];
    const depth = part.size[2] * transform.scale[2];
    const height = part.size[1] * transform.scale[1];
    const pitch = Math.abs(part.rotation?.[0] ?? 0);
    const roll = Math.abs(part.rotation?.[2] ?? 0);
    return pitch <= 2 && roll <= 2 && height <= Math.min(width, depth) * 0.5 && width * depth >= 0.25
      ? [{ part, transform }]
      : [];
  });
  return parts;
}

function isPointInsideAssemblySupportPart(
  position: readonly [number, number, number],
  component: LayoutDraftComponent,
  supportPart: NonNullable<LayoutDraftComponent["assembly"]>[number],
  transform: NonNullable<ReturnType<typeof getLayoutAssemblyUnitBoundsTransform>>,
  padding = 0.04,
) {
  const componentYaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
  const dx = position[0] - component.position[0];
  const dz = position[2] - component.position[2];
  const componentLocalX = Math.cos(componentYaw) * dx - Math.sin(componentYaw) * dz;
  const componentLocalZ = Math.sin(componentYaw) * dx + Math.cos(componentYaw) * dz;
  const fittedX = componentLocalX / component.size[0];
  const fittedZ = componentLocalZ / component.size[2];
  const observedPrisms = deriveObservedAssemblyPrisms(component.groundFootprint, getLayoutComponentAssembly(component));
  if (observedPrisms?.length) {
    const topY = transform.position[1] + (supportPart.position[1] + supportPart.size[1] / 2) * transform.scale[1];
    const point: [number, number] = [fittedX + 0.5, fittedZ + 0.5];
    const inside = (polygon: [number, number][]) => {
      let result = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [x, y] = polygon[i], [px, py] = polygon[j];
        if ((y > point[1]) !== (py > point[1]) && point[0] < (px - x) * (point[1] - y) / (py - y) + x) result = !result;
      }
      return result;
    };
    return observedPrisms.some((section) => Math.abs(section.yMax - topY) <= 1e-5 && inside(section.polygon));
  }
  const partYaw = (supportPart.rotation?.[1] ?? 0) * Math.PI / 180;
  const unfittedX = (fittedX - transform.position[0]) / transform.scale[0] - supportPart.position[0];
  const unfittedZ = (fittedZ - transform.position[2]) / transform.scale[2] - supportPart.position[2];
  const partLocalX = Math.cos(partYaw) * unfittedX - Math.sin(partYaw) * unfittedZ;
  const partLocalZ = Math.sin(partYaw) * unfittedX + Math.cos(partYaw) * unfittedZ;
  const paddingX = padding / (component.size[0] * transform.scale[0]);
  const paddingZ = padding / (component.size[2] * transform.scale[2]);
  return Math.abs(partLocalX) <= supportPart.size[0] / 2 + paddingX
    && Math.abs(partLocalZ) <= supportPart.size[2] / 2 + paddingZ;
}

function isPointInsideComponentFootprint(
  position: readonly [number, number, number],
  component: LayoutDraftComponent,
  padding = 0.04,
) {
  const supportParts = assemblySupportParts(component);
  if (supportParts.length) return supportParts.some(({ part, transform }) => isPointInsideAssemblySupportPart(position, component, part, transform, padding));
  if (getLayoutComponentAssembly(component)?.length) return false;
  const radians = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
  const dx = position[0] - component.position[0];
  const dz = position[2] - component.position[2];
  const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
  const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
  return Math.abs(localX) <= component.size[0] / 2 + padding
    && Math.abs(localZ) <= component.size[2] / 2 + padding;
}

function assemblySupportTopRatio(component: LayoutDraftComponent, position?: readonly [number, number, number]) {
  // Resolve the top of a broad horizontal piece in an assembly (mattress, shelf,
  // tabletop) instead of treating the assembly's whole bounding box as a surface.
  const candidates = assemblySupportParts(component).filter(({ part, transform }) =>
    !position || isPointInsideAssemblySupportPart(position, component, part, transform, 0));
  return candidates.length
    ? Math.max(...candidates.map(({ part, transform }) => transform.position[1] + (part.position[1] + part.size[1] / 2) * transform.scale[1]))
    : undefined;
}

function getSupportTopY(component: LayoutDraftComponent, groundHeight: number, position?: readonly [number, number, number]) {
  // ground 的语义以场景地面顶面为准；服务返回的 ground.position.y 不参与支撑计算。
  if (component.category === "ground") return groundHeight;
  const assemblyTopRatio = assemblySupportTopRatio(component, position);
  if (assemblyTopRatio !== undefined) return component.position[1] + component.size[1] * assemblyTopRatio;
  return component.position[1] + component.size[1];
}

export const getLayoutSupportTopY = getSupportTopY;

function canUseBoundingBoxTopAsSupport(component: LayoutDraftComponent) {
  if (component.assembly?.length) return assemblySupportTopRatio(component) !== undefined;
  return ["ground", "table", "cabinet", "prop"].includes(component.category)
    || assemblySupportTopRatio(component) !== undefined;
}

function isOpeningAttachedToWall(opening: LayoutDraftComponent, walls: readonly LayoutDraftComponent[]) {
  return walls.some((wall) => {
    const wallRunsAlongX = wall.size[0] >= wall.size[2];
    const expectedOpeningYaw = getLayoutComponentRotationYDegrees(wall) + (wallRunsAlongX ? 0 : 90);
    if (normalizeHalfTurnDifference(getLayoutComponentRotationYDegrees(opening), expectedOpeningYaw) > 18) return false;
    const radians = getLayoutComponentRotationYDegrees(wall) * Math.PI / 180;
    const dx = opening.position[0] - wall.position[0];
    const dz = opening.position[2] - wall.position[2];
    const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
    const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
    const alongWall = wallRunsAlongX ? localX : localZ;
    const acrossWall = wallRunsAlongX ? localZ : localX;
    const wallLength = wallRunsAlongX ? wall.size[0] : wall.size[2];
    const wallThickness = wallRunsAlongX ? wall.size[2] : wall.size[0];
    const verticalOverlap = opening.position[1] <= wall.position[1] + wall.size[1] + 0.12
      && opening.position[1] + opening.size[1] >= wall.position[1] - 0.12;
    return verticalOverlap
      && Math.abs(alongWall) + opening.size[0] / 2 <= wallLength / 2 + 0.12
      && Math.abs(acrossWall) <= (wallThickness + opening.size[2]) / 2 + 0.18;
  });
}

function appendOpeningAttachmentDiagnostics(components: LayoutDraftComponent[]) {
  const walls = components.filter((component) => component.category === "wall");
  return components.map((component) => {
    if (!["door", "window"].includes(component.category) || isOpeningAttachedToWall(component, walls)) return component;
    return {
      ...component,
      uncertain: true,
      notes: appendLayoutDiagnostic(component.notes, `${component.category === "door" ? "门" : "窗"}未依附可识别墙面，待确认位置与朝向`),
    };
  });
}

const LAYOUT_OBSERVATION_MAX_COUNT = 12;
const LAYOUT_RELATION_MAX_COUNT = 24;
const LAYOUT_SEMANTIC_TYPE_MAX_LENGTH = 48;

function normalizeLayoutSpaceType(value: unknown): LayoutSpaceType | undefined {
  return LAYOUT_SPACE_TYPES.includes(value as LayoutSpaceType) ? value as LayoutSpaceType : undefined;
}

function normalizeLayoutObservations(raw: unknown, componentIds: ReadonlySet<string>, warnings: Set<string>) {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > LAYOUT_OBSERVATION_MAX_COUNT) warnings.add("observations_truncated");
  const output: NonNullable<LayoutDraft["observations"]> = [];
  for (const item of raw.slice(0, LAYOUT_OBSERVATION_MAX_COUNT)) {
    if (!isRecord(item) || !LAYOUT_OBSERVATION_STATES.includes(item.state as LayoutObservationState)
      || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      warnings.add("observation_invalid");
      continue;
    }
    const componentId = typeof item.componentId === "string"
      ? boundedString(item.componentId, "", 48).replace(/[^a-zA-Z0-9_-]/g, "_") || undefined
      : undefined;
    if (componentId && !componentIds.has(componentId)) {
      warnings.add("observation_component_missing");
      continue;
    }
    output.push({
      ...(componentId ? { componentId } : {}),
      state: item.state as LayoutObservationState,
      confidence: item.confidence,
      ...(typeof item.evidence === "string" && item.evidence.trim()
        ? { evidence: item.evidence.trim().slice(0, 160) }
        : {}),
    });
  }
  return output.length ? output : undefined;
}

function normalizeLayoutRelations(raw: unknown, componentIds: ReadonlySet<string>, warnings: Set<string>) {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > LAYOUT_RELATION_MAX_COUNT) warnings.add("relations_truncated");
  const output: NonNullable<LayoutDraft["relations"]> = [];
  for (const item of raw.slice(0, LAYOUT_RELATION_MAX_COUNT)) {
    if (!isRecord(item) || typeof item.fromId !== "string" || typeof item.toId !== "string"
      || !LAYOUT_RELATION_TYPES.includes(item.type as LayoutRelationType)
      || typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) {
      warnings.add("relation_invalid");
      continue;
    }
    const fromId = boundedString(item.fromId, "", 48).replace(/[^a-zA-Z0-9_-]/g, "_");
    const toId = boundedString(item.toId, "", 48).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!fromId || !toId || fromId === toId || !componentIds.has(fromId) || !componentIds.has(toId)) {
      warnings.add("relation_endpoint_missing");
      continue;
    }
    output.push({ fromId, toId, type: item.type as LayoutRelationType, confidence: item.confidence });
  }
  return output.length ? output : undefined;
}

/** Only high-confidence wall attachment for thin openings may alter their yaw/position. */
function resolveExplicitLayoutRelations(
  components: LayoutDraftComponent[],
  relations: NonNullable<LayoutDraft["relations"]>,
  warnings: Set<string>,
) {
  const byId = new Map(components.map((component) => [component.id, component]));
  const patches = new Map<string, LayoutDraftComponent>();
  for (const relation of relations) {
    const from = patches.get(relation.fromId) ?? byId.get(relation.fromId)!;
    const to = patches.get(relation.toId) ?? byId.get(relation.toId)!;
    if (relation.type === "attached_to") {
      const opening = ["door", "window"].includes(from.category) ? from : ["door", "window"].includes(to.category) ? to : undefined;
      const wall = from.category === "wall" ? from : to.category === "wall" ? to : undefined;
      const mountedProp = wall && (from.category === "prop" || to.category === "prop")
        ? (from.category === "prop" ? from : to)
        : undefined;
      if (mountedProp) {
        if (relation.confidence < 0.65 || mountedProp.confidence < 0.65 || wall!.confidence < 0.65) {
          warnings.add("attachment_unresolved");
        }
        // The observation converter already places a wall-mounted prop from its
        // image bbox. Keep the relation editable without applying opening snaps.
        continue;
      }
      if (!opening || !wall || relation.confidence < 0.8 || opening.confidence < 0.65 || wall.confidence < 0.65) {
        warnings.add("attachment_unresolved");
        continue;
      }
      const wallRunsAlongX = wall.size[0] >= wall.size[2];
      const expectedYaw = getLayoutComponentRotationYDegrees(wall) + (wallRunsAlongX ? 0 : 90);
      const radians = getLayoutComponentRotationYDegrees(wall) * Math.PI / 180;
      const dx = opening.position[0] - wall.position[0];
      const dz = opening.position[2] - wall.position[2];
      const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
      const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
      const along = wallRunsAlongX ? localX : localZ;
      const wallLength = wallRunsAlongX ? wall.size[0] : wall.size[2];
      const openingWidth = opening.size[0];
      const verticalOverlap = opening.position[1] <= wall.position[1] + wall.size[1] + 0.12
        && opening.position[1] + opening.size[1] >= wall.position[1] - 0.12;
      if (Math.abs(along) + openingWidth / 2 > wallLength / 2 + 0.12 || !verticalOverlap) {
        warnings.add("attachment_geometry_conflict");
        continue;
      }
      const snappedPosition: [number, number, number] = wallRunsAlongX
        ? [wall.position[0] + Math.cos(radians) * along, opening.position[1], wall.position[2] - Math.sin(radians) * along]
        : [wall.position[0] + Math.sin(radians) * along, opening.position[1], wall.position[2] + Math.cos(radians) * along];
      const changed = Math.abs(normalizeHalfTurnDifference(getLayoutComponentRotationYDegrees(opening), expectedYaw)) > 0.1
        || Math.hypot(opening.position[0] - snappedPosition[0], opening.position[2] - snappedPosition[2]) > 0.02;
      if (changed) {
        patches.set(opening.id, {
          ...withLayoutComponentRotationYDegrees(opening, expectedYaw),
          position: snappedPosition,
          uncertain: true,
          notes: appendLayoutDiagnostic(opening.notes, "已按明确的 attached_to 关系吸附到墙面，位置/朝向已自动修正，请复核"),
        });
        warnings.add("attachment_adjusted_review");
      }
    } else if (relation.type === "head_at" && from.semanticType === "bed" && to.category === "wall") {
      // Bed local -Z is its head end. Measure that point against the rotated wall plane
      // and along-wall bounds; never rotate or translate the bed from this soft relation.
      const radians = to.rotationYDegrees * Math.PI / 180;
      const bedHalfDepth = from.size[2] / 2;
      const headX = from.position[0] - Math.sin(from.rotationYDegrees * Math.PI / 180) * bedHalfDepth;
      const headZ = from.position[2] - Math.cos(from.rotationYDegrees * Math.PI / 180) * bedHalfDepth;
      const dx = headX - to.position[0];
      const dz = headZ - to.position[2];
      const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
      const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
      const wallRunsAlongX = to.size[0] >= to.size[2];
      const along = wallRunsAlongX ? localX : localZ;
      const across = wallRunsAlongX ? localZ : localX;
      const wallLength = wallRunsAlongX ? to.size[0] : to.size[2];
      const wallThickness = wallRunsAlongX ? to.size[2] : to.size[0];
      const inWallSpan = Math.abs(along) <= wallLength / 2 + 0.2;
      const nearWallPlane = Math.abs(across) <= wallThickness / 2 + 0.25;
      if (!inWallSpan || !nearWallPlane) {
        patches.set(from.id, {
          ...from,
          uncertain: true,
          notes: appendLayoutDiagnostic(from.notes, "head_at 关系与床头点/目标墙几何不符；保留原位，待确认"),
        });
        warnings.add("head_at_geometry_conflict");
      }
    } else if (relation.type === "head_at") {
      const note = "head_at端点应为床体（semanticType=bed）指向墙；关系待确认";
      patches.set(from.id, {
        ...from,
        uncertain: true,
        notes: appendLayoutDiagnostic(from.notes, note),
      });
      patches.set(to.id, {
        ...to,
        uncertain: true,
        notes: appendLayoutDiagnostic(to.notes, note),
      });
      warnings.add("head_at_endpoint_invalid");
    }
  }
  return components.map((component) => patches.get(component.id) ?? component);
}

function warnComponentsAboveKnownRoomHeight(
  components: LayoutDraftComponent[],
  spaceType: LayoutSpaceType | undefined,
  warnings: Set<string>,
) {
  if (spaceType !== "enclosed") return components;
  const knownWallTops = components
    .filter((component) => component.category === "wall" && component.visible && !component.uncertain && component.confidence >= 0.65)
    .map((wall) => wall.position[1] + wall.size[1]);
  if (!knownWallTops.length) return components;
  const roomTop = Math.max(...knownWallTops);
  let hasOutlier = false;
  const result = components.map((component) => {
    if (!component.visible || component.category === "ground" || component.category === "wall"
      || component.position[1] + component.size[1] <= roomTop + 0.1) return component;
    hasOutlier = true;
    return {
      ...component,
      uncertain: true,
      notes: appendLayoutDiagnostic(component.notes, "组件顶部超出已识别墙高；保留原几何，待对照参考图确认"),
    };
  });
  if (hasOutlier) warnings.add("component_exceeds_room_height");
  return result;
}

function resolveLayoutSupportGraph(
  components: LayoutDraftComponent[],
  characters: LayoutDraftCharacter[],
  groundHeight = 0,
) {
  const byId = new Map(components.map((component) => [component.id, component]));
  const resolved = new Map<string, LayoutDraftComponent>();
  const resolving = new Set<string>();
  const cyclicSupportIds = new Set<string>();
  components.forEach((component) => {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: LayoutDraftComponent | undefined = component;
    while (current?.supportComponentId && byId.has(current.supportComponentId)) {
      const repeatedAt = pathIndex.get(current.id);
      if (repeatedAt !== undefined) {
        path.slice(repeatedAt).forEach((id) => cyclicSupportIds.add(id));
        break;
      }
      pathIndex.set(current.id, path.length);
      path.push(current.id);
      current = byId.get(current.supportComponentId);
    }
  });

  const resolveComponent = (id: string): LayoutDraftComponent => {
    const cached = resolved.get(id);
    if (cached) return cached;
    const component = byId.get(id)!;
    let next = component;
    const supportId = component.supportComponentId;

    if (supportId && cyclicSupportIds.has(id)) {
      next = {
        ...component,
        uncertain: true,
        notes: appendLayoutDiagnostic(component.notes, `支撑关系与 ${supportId} 构成循环，未自动调整 Y`),
      };
    } else if (supportId) {
      const support = byId.get(supportId);
      if (!support || supportId === id) {
        next = {
          ...component,
          uncertain: true,
          notes: appendLayoutDiagnostic(component.notes, supportId === id
            ? "支撑关系引用了组件自身，未自动调整 Y"
            : `支撑组件 ${supportId} 不存在，未自动调整 Y`),
        };
      } else if (resolving.has(supportId)) {
        next = {
          ...component,
          uncertain: true,
          notes: appendLayoutDiagnostic(component.notes, `支撑关系与 ${supportId} 构成循环，未自动调整 Y`),
        };
      } else {
        resolving.add(id);
        const resolvedSupport = resolveComponent(supportId);
        resolving.delete(id);
        if (!canUseBoundingBoxTopAsSupport(resolvedSupport)) {
          next = {
            ...component,
            uncertain: true,
            notes: appendLayoutDiagnostic(
              component.notes,
              `支撑组件 ${supportId} 的包围盒顶面不代表可确认承载面，未自动调整 Y`,
            ),
          };
        } else if (!isPointInsideComponentFootprint(component.position, resolvedSupport)) {
          next = {
            ...component,
            uncertain: true,
            notes: appendLayoutDiagnostic(
              component.notes,
              `与支撑组件 ${supportId} 的水平足迹不重叠，未自动调整 Y`,
            ),
          };
        } else {
          const expectedY = getSupportTopY(resolvedSupport, groundHeight, component.position);
          const difference = Math.abs(component.position[1] - expectedY);
          next = {
            ...component,
            position: [component.position[0], expectedY, component.position[2]],
            uncertain: component.uncertain || resolvedSupport.uncertain || difference > LAYOUT_SUPPORT_Y_TOLERANCE,
            notes: difference > LAYOUT_SUPPORT_Y_TOLERANCE
              ? appendLayoutDiagnostic(component.notes, `已按支撑组件 ${supportId} 顶面把 Y 从 ${component.position[1]} 修正为 ${expectedY}`)
              : component.notes,
          };
        }
      }
    } else if (["wall", "pillar"].includes(component.category)
      && Math.abs(component.position[1] - (groundHeight + component.size[1] / 2)) <= LAYOUT_SUPPORT_Y_TOLERANCE) {
      next = {
        ...component,
        position: [component.position[0], groundHeight, component.position[2]],
        uncertain: true,
        notes: appendLayoutDiagnostic(
          component.notes,
          `检测到旧版几何中心 Y=${component.position[1]}，已按底部中心语义修正为 ${groundHeight}`,
        ),
      };
    } else if (["wall", "pillar"].includes(component.category)
      && Math.abs(component.position[1] - groundHeight) > LAYOUT_SUPPORT_Y_TOLERANCE) {
      next = {
        ...component,
        uncertain: true,
        notes: appendLayoutDiagnostic(
          component.notes,
          `底面 Y=${component.position[1]} 未对齐地面 ${groundHeight}；可能是合法悬空墙段/台上柱，也可能误用了几何中心 Y，待确认`,
        ),
      };
    }

    resolved.set(id, next);
    return next;
  };

  components.forEach((component) => resolveComponent(component.id));
  const resolvedComponents = appendOpeningAttachmentDiagnostics(
    components.map((component) => resolved.get(component.id) ?? component),
  );
  const resolvedById = new Map(resolvedComponents.map((component) => [component.id, component]));

  const resolvedCharacters = characters.map((character) => {
    const supportId = character.supportComponentId;
    if (supportId) {
      const support = resolvedById.get(supportId);
      if (!support) {
        return {
          ...character,
          uncertain: true,
          notes: appendLayoutDiagnostic(character.notes, `支撑组件 ${supportId} 不存在，未自动调整人物 Y`),
        };
      }
      if (!canUseBoundingBoxTopAsSupport(support)
        || (character.posture === "sit" && ["chair", "sofa"].includes(support.category))) {
        return {
          ...character,
          uncertain: true,
          notes: appendLayoutDiagnostic(
            character.notes,
            `支撑组件 ${supportId} 的包围盒顶面不等于可确认座面/承载面，未自动调整人物 Y`,
          ),
        };
      }
      if (!isPointInsideComponentFootprint(character.position, support)) {
        return {
          ...character,
          uncertain: true,
          notes: appendLayoutDiagnostic(
            character.notes,
            `与支撑组件 ${supportId} 的水平足迹不重叠，未自动调整人物 Y`,
          ),
        };
      }
      const expectedY = getSupportTopY(support, groundHeight, character.position);
      const difference = Math.abs(character.position[1] - expectedY);
      return {
        ...character,
        position: [character.position[0], expectedY, character.position[2]] as [number, number, number],
        uncertain: character.uncertain || support.uncertain || difference > LAYOUT_SUPPORT_Y_TOLERANCE,
        notes: difference > LAYOUT_SUPPORT_Y_TOLERANCE
          ? appendLayoutDiagnostic(character.notes, `已按支撑组件 ${supportId} 顶面把人物 Y 从 ${character.position[1]} 修正为 ${expectedY}`)
          : character.notes,
      };
    }

    // 旧草稿没有显式支撑关系时只诊断，不凭名称或邻近关系静默改位置。
    if (!["stand", "crouch", "kneel"].includes(character.posture)) return character;
    const nearbySupport = resolvedComponents
      .filter((component) => ["table", "cabinet", "prop"].includes(component.category))
      .filter((component) => isPointInsideComponentFootprint(character.position, component))
      .map((component) => ({ component, topY: getSupportTopY(component, groundHeight, character.position) }))
      .filter(({ topY }) => Math.abs(topY - character.position[1]) <= LAYOUT_LEGACY_SUPPORT_NEARBY_TOLERANCE)
      .sort((left, right) => Math.abs(left.topY - character.position[1]) - Math.abs(right.topY - character.position[1]))[0];
    if (!nearbySupport || Math.abs(nearbySupport.topY - character.position[1]) <= LAYOUT_SUPPORT_Y_TOLERANCE) {
      return character;
    }
    return {
      ...character,
      uncertain: true,
      notes: appendLayoutDiagnostic(
        character.notes,
        `人物 Y=${character.position[1]} 与近邻组件 ${nearbySupport.component.id} 顶面 Y=${nearbySupport.topY} 不一致；缺少 supportComponentId，未自动修正`,
      ),
    };
  });

  return { components: resolvedComponents, characters: resolvedCharacters };
}

export function validateLayoutDraftCandidate(
  candidate: unknown,
  source: LayoutDraftSource,
  options: { draftId?: string; createdAt?: string; imageAspectRatio?: number } = {}
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
    const semanticType = typeof raw.semanticType === "string"
      ? raw.semanticType.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, LAYOUT_SEMANTIC_TYPE_MAX_LENGTH) || undefined
      : undefined;
    const normalizedAssembly = normalizeLayoutAssembly(raw.assembly);
    const groundFootprint = normalizeGroundFootprint(raw.groundFootprint);
    const semanticProfile = resolveLayoutSemanticProfile(semanticType, semanticType ? undefined : boundedString(raw.name, "", 80));
    // Legacy draft producers used "prop" as a broad bucket while relying on
    // semanticType for detailed assemblies. Observation conversion handles
    // explicit category conflicts by supplying a bounded neutral assembly.
    const semanticCategoryConflict = Boolean(semanticProfile && semanticProfile.category !== category && category !== "prop");
    const assembly = normalizedAssembly
      ?? (semanticCategoryConflict ? undefined : buildSemanticLayoutAssembly(semanticProfile?.canonicalType ?? semanticType));
    const renderAssembly = assembly ?? getDefaultLayoutCategoryAssembly(String(category), boundedString(raw.name, "", 80), primitive === "cylinder" ? "cylinder" : "box");
    const footprintNeedsReview = Boolean(groundFootprint?.length && !deriveObservedAssemblyPrisms(groundFootprint, renderAssembly));
    const supportComponentId = typeof raw.supportComponentId === "string"
      ? boundedString(raw.supportComponentId, "", 48).replace(/[^a-zA-Z0-9_-]/g, "_") || undefined
      : undefined;
    const sourceEvidence = isRecord(raw.sourceImageEvidence) ? raw.sourceImageEvidence : undefined;
    const sourceBbox = sourceEvidence && Array.isArray(sourceEvidence.bbox)
      && sourceEvidence.bbox.length === 4
      && sourceEvidence.bbox.every((value) => typeof value === "number" && Number.isFinite(value))
      ? sourceEvidence.bbox as [number, number, number, number]
      : undefined;
    const sourceEvidenceConfidence = sourceEvidence?.confidence;
    const sourceEvidenceVisibility = sourceEvidence?.visibility;
    const generatedAssetRefId = typeof raw.generatedAssetRefId === "string"
      ? boundedString(raw.generatedAssetRefId, "", 120).replace(/[^a-zA-Z0-9_-]/g, "_") || undefined
      : undefined;
    const generatedAssetState = ["generating", "ready", "failed"].includes(String(raw.generatedAssetState))
      ? raw.generatedAssetState as "generating" | "ready" | "failed"
      : undefined;
    const partOfComponentId = typeof raw.partOfComponentId === "string"
      ? boundedString(raw.partOfComponentId, "", 48).replace(/[^a-zA-Z0-9_-]/g, "_") || undefined
      : undefined;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      issues.push(`${label}的置信度必须在 0 到 1 之间`);
    }
    if (raw.assembly !== undefined && !normalizeLayoutAssembly(raw.assembly)) {
      issues.push(`${label}的 assembly 必须是父组件包围盒内最多 24 个轴对齐受限子件`);
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
      ...(supportComponentId ? { supportComponentId } : {}),
      ...(partOfComponentId ? { partOfComponentId } : {}),
      rotationYDegrees,
      confidence,
      uncertain: raw.uncertain === true || confidence < 0.65 || semanticCategoryConflict || footprintNeedsReview,
      modelDescriptor: boundedString(raw.modelDescriptor, "", 120) || undefined,
      ...(semanticType ? { semanticType } : {}),
      appearance: normalizeLayoutAppearance(raw.appearance, rotationYDegrees),
      ...(assembly ? { assembly } : {}),
      ...(groundFootprint ? { groundFootprint } : {}),
      ...(sourceBbox && sourceBbox[0] >= 0 && sourceBbox[1] >= 0
        && sourceBbox[2] <= 1 && sourceBbox[3] <= 1
        && sourceBbox[2] > sourceBbox[0] && sourceBbox[3] > sourceBbox[1]
        && typeof sourceEvidenceConfidence === "number" && Number.isFinite(sourceEvidenceConfidence)
        && ["visible", "partial", "occluded", "uncertain"].includes(String(sourceEvidenceVisibility))
        ? { sourceImageEvidence: {
          bbox: [...sourceBbox] as [number, number, number, number],
          confidence: Math.max(0, Math.min(1, sourceEvidenceConfidence)),
          visibility: sourceEvidenceVisibility as "visible" | "partial" | "occluded" | "uncertain",
          ...(typeof sourceEvidence?.sourceId === "string" && sourceEvidence.sourceId.length <= 128 ? { sourceId: sourceEvidence.sourceId } : {}),
          ...(sourceEvidence?.hasPartComponents === true ? { hasPartComponents: true } : {}),
        } }
        : {}),
      ...(generatedAssetRefId ? { generatedAssetRefId, generatedAssetNeedsReview: raw.generatedAssetNeedsReview !== false } : {}),
      ...(generatedAssetState && !generatedAssetRefId ? { generatedAssetState } : {}),
      ...(generatedAssetRefId && raw.generatedAssetUnavailable === true ? { generatedAssetUnavailable: true } : {}),
      notes: [boundedString(raw.notes, "", 240), semanticCategoryConflict ? "基础几何类别与语义身份提示冲突；保留原语义供诊断，不按该语义生成assembly，待确认。" : "", footprintNeedsReview ? "平面轮廓无法与当前可渲染部件可靠相交；渲染与碰撞保留保守assembly，轮廓待复核。" : ""]
        .filter(Boolean).join(" ").slice(0, 240) || undefined,
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
  const metadataWarnings = new Set<string>();
  const componentIds = new Set(normalizedComponents.map((component) => component.id));
  const spaceType = normalizeLayoutSpaceType(parsed.spaceType);
  if (parsed.spaceType !== undefined && !spaceType) metadataWarnings.add("space_type_invalid");
  const observations = normalizeLayoutObservations(parsed.observations, componentIds, metadataWarnings);
  const relations = normalizeLayoutRelations(parsed.relations, componentIds, metadataWarnings);
  const hasStructuredMetadata = parsed.spaceType !== undefined
    || parsed.observations !== undefined
    || parsed.relations !== undefined
    || normalizedComponents.some((component) => Boolean(component.semanticType || component.assembly));
  const visibleComponents = normalizedComponents.filter((component) => component.visible);
  if (hasStructuredMetadata && visibleComponents.length > 0
    && visibleComponents.every((component) => !component.appearance?.color)) {
    metadataWarnings.add("appearance_color_missing");
  }

  // 人物解析：缺省为空数组（纯布景图合法）；超过上限截断而非报错；
  // 单个结构非法的人物跳过，取值范围外夹紧并标记 uncertain。
  const rawCharacters = Array.isArray(parsed.characters) ? parsed.characters.slice(0, LAYOUT_CHARACTER_MAX_COUNT) : [];
  const characters = rawCharacters
    .map((raw, index) => normalizeLayoutCharacter(raw, index, seenIds))
    .filter((item): item is LayoutDraftCharacter => Boolean(item));
  const supported = resolveLayoutSupportGraph(normalizedComponents, characters);
  const relatedComponents = relations
    ? resolveExplicitLayoutRelations(supported.components, relations, metadataWarnings)
    : supported.components;
  const checkedComponents = warnComponentsAboveKnownRoomHeight(relatedComponents, spaceType, metadataWarnings);

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
    referenceCamera: normalizeLayoutReferenceCamera(
      parsed.referenceCamera,
      supported.components,
      Number.isFinite(options.imageAspectRatio) && options.imageAspectRatio! >= 0.1 && options.imageAspectRatio! <= 10
        ? options.imageAspectRatio
        : undefined,
    ),
    ...(spaceType ? { spaceType } : {}),
    ...(observations ? { observations } : {}),
    ...(relations ? { relations } : {}),
    ...(metadataWarnings.size ? { validationWarnings: [...metadataWarnings].slice(0, 12) } : {}),
    components: carveDoorOpenings(appendOpeningAttachmentDiagnostics(checkedComponents)),
    characters: supported.characters,
  };
}

export function getLayoutComponentRenderPosition(
  component: LayoutDraftComponent,
  groundHeight = 0,
): [number, number, number] {
  return component.category === "ground"
    // 让参考地面顶面比编辑器默认 ground plane 高 2mm，避免预览/应用时 z-fighting 而只看见蓝色网格。
    ? [component.position[0], groundHeight - component.size[1] + 0.002, component.position[2]]
    : [...component.position];
}

/** 外观语义中的局部 +Z 正面优先于通用 yaw，供预览与正式对象共用。 */
export function getLayoutComponentRotationYDegrees(component: Pick<LayoutDraftComponent, "rotationYDegrees" | "appearance">) {
  return component.appearance?.frontDirectionDegrees ?? component.rotationYDegrees;
}

export function withLayoutComponentRotationYDegrees<T extends Pick<LayoutDraftComponent, "rotationYDegrees" | "appearance">>(component: T, degrees: number): T {
  return {
    ...component,
    rotationYDegrees: degrees,
    ...(component.appearance?.frontDirectionDegrees !== undefined
      ? { appearance: { ...component.appearance, frontDirectionDegrees: degrees } }
      : {}),
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
    referenceCamera: {
      ...getLayoutDraftReferenceCamera(draft),
      position: getLayoutDraftReferenceCamera(draft).position.map((value) => value * factor) as [number, number, number],
      target: getLayoutDraftReferenceCamera(draft).target.map((value) => value * factor) as [number, number, number],
    },
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

/** 草稿预览与正式入场共用的人物渲染适配，避免体型、姿态和身高换算分叉。 */
export function createLayoutCharacterRenderAdapter(character: LayoutDraftCharacter) {
  const bodyType = LAYOUT_BODY_HINT_TO_BODY_TYPE[character.bodyTypeHint];
  const posePresetId = character.posture === "kneel" && character.kneelVariant
    ? ({ "one-knee": "kneel-one", "two-knee": "kneel-two", seiza: "seiza" } as const)[character.kneelVariant]
    : LAYOUT_POSTURE_TO_POSE_PRESET[character.posture];
  const posePreset = MANNEQUIN_POSE_PRESETS.find((preset) => preset.id === posePresetId);
  const handGestureControls: Record<string, number> = character.handGesture === "prayer"
    ? {
        "leftShoulder.pitch": 52,
        "rightShoulder.pitch": 52,
        "leftShoulder.spread": -24,
        "rightShoulder.spread": 24,
        "leftShoulder.twist": 46,
        "rightShoulder.twist": -46,
        "leftElbow.bend": 96,
        "rightElbow.bend": 96,
        "leftHand.roll": -10,
        "rightHand.roll": 10,
      }
    : {};
  const canonicalHeight = getLayoutCharacterCanonicalHeight(bodyType);
  const scaleFactor = character.height / canonicalHeight;
  const rootPosition = [...character.position] as [number, number, number];
  if (character.posture === "sit") {
    rootPosition[1] -= getUE4SeatedPelvisSupportHeight(bodyType) * scaleFactor;
  }

  return {
    bodyType,
    color: LAYOUT_CHARACTER_COLOR,
    transform: {
      position: rootPosition,
      rotation: [0, character.rotationYDegrees * Math.PI / 180, 0] as [number, number, number],
      scale: [scaleFactor, scaleFactor, scaleFactor] as [number, number, number],
    },
    characterRig: {
      rigType: "ue4-mannequin" as const,
      posePresetId,
      controls: posePreset ? { ...posePreset.controls, ...handGestureControls } : handGestureControls,
    },
  };
}

export function buildLayoutBatch(
  draft: LayoutDraft,
  batchId: string,
  existingObjectIds: readonly string[],
  groundHeight = 0
): { batch: DirectorLayoutBatch; objects: DirectorObject[] } {
  const usedIds = new Set(existingObjectIds);
  const objects = draft.components.map((component) => {
    const representation = component.generatedAssetRefId
      ? { kind: "geometry" as const }
      : resolveLayoutComponentRepresentation(draft, component);
    const renderAssembly = getLayoutComponentAssembly(component);
    const id = uniqueId(`${sanitizeId(batchId)}_${sanitizeId(component.id)}`, usedIds);
    return {
      id,
      name: component.name,
      kind: "prop" as const,
      visible: component.visible,
      locked: false,
      geometryType: component.primitive,
      color: component.appearance?.color ?? LAYOUT_CATEGORY_COLORS[component.category],
      transform: {
        position: getLayoutComponentRenderPosition(component, groundHeight),
        rotation: [0, getLayoutComponentRotationYDegrees(component) * Math.PI / 180 + (representation.kind === "catalog" ? representation.yawCorrectionRadians : 0), 0] as [number, number, number],
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
        uncertain: component.uncertain || Boolean(component.generatedAssetNeedsReview),
        ...(component.generatedAssetRefId ? {
          generatedAssetSource: "reference-image-object-v1" as const,
          generatedAssetFit: "uniform-contained-bottom-center-v1" as const,
          generatedAssetFitTargetSize: [...component.size] as [number, number, number],
          generatedAssetNeedsReview: component.generatedAssetNeedsReview !== false,
        } : {}),
        ...(representation.kind === "catalog" ? { catalogFit: LAYOUT_CATALOG_FIT_MODE } : {}),
        ...(component.modelDescriptor ? { modelDescriptor: component.modelDescriptor } : {}),
        ...(component.appearance ? { appearance: { ...component.appearance } } : {}),
        ...(renderAssembly ? { assembly: renderAssembly.map((part) => ({ ...part, position: [...part.position] as [number, number, number], size: [...part.size] as [number, number, number], ...(part.rotation ? { rotation: [...part.rotation] as [number, number, number] } : {}) })) } : {}),
        ...(component.groundFootprint ? { groundFootprint: component.groundFootprint.map((part) => ({ ...part, outer: part.outer.map((point) => [...point] as [number, number]), ...(part.holes ? { holes: part.holes.map((loop) => loop.map((point) => [...point] as [number, number])) } : {}) })) } : {}),
      },
      ...(component.generatedAssetRefId ? { assetRefId: component.generatedAssetRefId } : {}),
    } satisfies DirectorObject;
  });

  // 人物占位：按估算身高换算素体缩放（scale=height/NATIVE），与手动添加的角色同权
  const characterObjects = draft.characters.map((character) => {
    const id = uniqueId(`${sanitizeId(batchId)}_${sanitizeId(character.id)}`, usedIds);
    const adapter = createLayoutCharacterRenderAdapter(character);
    return {
      id,
      name: character.name,
      kind: "character" as const,
      visible: character.visible,
      locked: false,
      ...adapter,
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
          ...(character.facingDirection ? { facingDirection: character.facingDirection } : {}),
          ...(character.kneelVariant ? { kneelVariant: character.kneelVariant } : {}),
          ...(character.handGesture ? { handGesture: character.handGesture } : {}),
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
      referenceCamera: { ...getLayoutDraftReferenceCamera(draft) },
    },
  };
}
