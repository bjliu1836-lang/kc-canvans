import type { DirectorLayoutCategory } from "./directorProject";
import { deriveObservedAssemblyPrisms, getLayoutAssemblyUnitBoundsTransform } from "../canvas/layoutGeometryBounds";
import {
  getLayoutComponentRotationYDegrees,
  getLayoutComponentAssembly,
  getLayoutSupportTopY,
  validateLayoutDraftCandidate,
  withLayoutComponentRotationYDegrees,
  type LayoutDraftComponent,
  type LayoutDraftCharacter,
  type LayoutDraft,
  type LayoutDraftSource,
  type LayoutSpaceType,
} from "./layoutDraft";
import { resolveLayoutSemanticProfile } from "./layoutSemanticProfiles";
import {
  calibrateGroundCamera,
  estimateGroundContactCenter,
  projectImagePointToGround,
  type CalibratedGroundCamera,
  type GroundContactEvidence,
  type ReferenceGroundEvidence,
} from "./referenceGroundProjection";

/** Canonical image basis: camera at +Z looking toward -Z; image right is +X. */
export type ImageSurfaceSide = "image_left" | "image_right" | "image_back" | "floor" | "unknown";
export type ImageVisibility = "visible" | "partly_occluded" | "occluded" | "uncertain";
export type NormalizedImageBox = [left: number, top: number, right: number, bottom: number];
export type ContactWallSide = "image_left" | "image_right" | "image_back" | "unknown" | "none";
export type ImageScreenDirection = "image_left" | "image_right" | "image_up" | "image_down" | "unknown";
export type ImageFacingDirection = "image_left" | "image_right" | "toward_camera" | "away_from_camera" | "unknown";
export type ImageItemPlacement = "wall_attached" | "floor" | "supported" | "unknown";

export interface ImageObservationSurface {
  id: string;
  kind: "wall" | "floor";
  side: ImageSurfaceSide;
  bbox: NormalizedImageBox;
  confidence: number;
  visibility?: ImageVisibility;
  mainColor?: string | null;
  color?: string | null;
  appearance?: { color?: string | null };
}

type ProjectedFootprintPart = { outer: [number, number][]; holes: [number, number][][]; confidence: number; visibility: "visible" | "inferred" };

function pointInLoop(x: number, z: number, loop: readonly [number, number][]) {
  let inside = false;
  for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index++) {
    const [xi, zi] = loop[index], [xj, zj] = loop[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function imageSegmentsIntersect(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]) {
  const cross = (p: readonly number[], q: readonly number[], r: readonly number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const onSegment = (p: readonly number[], q: readonly number[], r: readonly number[]) => Math.abs(cross(p, q, r)) <= 1e-10
    && r[0] >= Math.min(p[0], q[0]) - 1e-10 && r[0] <= Math.max(p[0], q[0]) + 1e-10
    && r[1] >= Math.min(p[1], q[1]) - 1e-10 && r[1] <= Math.max(p[1], q[1]) + 1e-10;
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > 1e-10 && abD < -1e-10) || (abC < -1e-10 && abD > 1e-10))
    && ((cdA > 1e-10 && cdB < -1e-10) || (cdA < -1e-10 && cdB > 1e-10))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function imageLoopsIntersect(a: readonly [number, number][], b: readonly [number, number][]) {
  return a.some((start, index) => b.some((otherStart, otherIndex) => imageSegmentsIntersect(
    start, a[(index + 1) % a.length], otherStart, b[(otherIndex + 1) % b.length],
  )));
}

function imageFootprintsToWorld(item: ImageObservationItem, camera: CalibratedGroundCamera | undefined, aspect: number): ProjectedFootprintPart[] {
  if (!camera || !item.groundFootprints?.length || item.confidence < 0.55) return [];
  return item.groundFootprints.flatMap((footprint) => {
    const projectLoop = (loop: [number, number][]) => loop.map((point) => projectImagePointToGround(point, camera, aspect)).filter((point): point is [number, number, number] => Boolean(point)).map(([x, , z]) => [x, z] as [number, number]);
    const outer = projectLoop(footprint.outer);
    const holes = (footprint.holes ?? []).map(projectLoop);
    if (outer.length !== footprint.outer.length || outer.length < 3 || holes.some((hole, index) => hole.length !== footprint.holes![index].length || hole.length < 3)) return [];
    return [{ outer, holes, confidence: footprint.confidence * (footprint.visibility === "visible" ? 1 : 0.45), visibility: footprint.visibility }];
  });
}

export interface ImageObservationItem {
  id: string;
  name: string;
  /** Prefer an existing category; semanticType stays open to future local presets. */
  category?: DirectorLayoutCategory;
  semanticType?: string;
  bbox: NormalizedImageBox;
  confidence: number;
  visibility: ImageVisibility;
  mainColor?: string | null;
  againstSurfaceId?: string;
  contactWallSide?: ContactWallSide;
  rearFeature?: { name: string; bbox: NormalizedImageBox };
  bodyExtendsToward?: ImageScreenDirection;
  color?: string | null;
  appearance?: { color?: string | null };
  supportId?: string;
  partOfId?: string;
  placement?: ImageItemPlacement;
  facingTowardId?: string;
  groundContacts?: GroundContactEvidence[];
  visibleBbox?: NormalizedImageBox;
  completeBbox?: NormalizedImageBox;
  occludesIds?: string[];
  groundFootprints?: Array<{
    outer: [number, number][];
    holes?: [number, number][][];
    visibility: "visible" | "inferred";
    confidence: number;
  }>;
}

export interface ImageObservationPerson {
  id: string;
  name: string;
  bbox: NormalizedImageBox;
  confidence: number;
  visibility: ImageVisibility;
  posture?: "stand" | "sit" | "crouch" | "kneel" | "lie" | "unknown";
  facingDirection?: ImageFacingDirection | "image_up" | "image_down";
  kneelVariant?: "one-knee" | "two-knee" | "seiza";
  handGesture?: "prayer";
  supportId?: string;
}

export interface ImageObservation {
  spaceType?: LayoutSpaceType;
  imageAspectRatio?: number;
  surfaces: ImageObservationSurface[];
  items: ImageObservationItem[];
  people?: ImageObservationPerson[];
  geometryEvidence?: ReferenceGroundEvidence;
}

export interface ImageObservationLayoutOptions {
  draftId?: string;
  createdAt?: string;
  imageAspectRatio?: number;
}

export class ImageObservationValidationError extends Error {
  readonly kind: "schema" | "geometry";

  constructor(message: string, kind: "schema" | "geometry" = "schema") {
    super(message);
    this.name = "ImageObservationValidationError";
    this.kind = kind;
  }
}

const MAX_SURFACES = 8;
const MAX_ITEMS = 30;
const MAX_GROUND_CONTACTS = 8;
const MAX_GROUND_LINES_PER_AXIS = 8;
const MAX_GROUND_FOOTPRINTS = 3;
const MAX_ID_LENGTH = 48;
const ROOM_WIDTH_METERS = 6;
const ROOM_DEPTH_METERS = 6;
const ROOM_HEIGHT_METERS = 2.8;
const WALL_THICKNESS_METERS = 0.15;
const ATTACHMENT_GAP_METERS = 0.025;
const METERS_PER_IMAGE_EXTENT = 6;
const BOX_NOTE = "位置与范围按图像框和通用尺度估算；单张图不能确定精确深度或尺寸，待确认。";

const SEMANTIC_CATEGORY: Record<string, DirectorLayoutCategory> = {
  bed: "sofa",
  bookshelf: "cabinet",
  cabinet: "cabinet",
  window: "window",
  door: "door",
  desk: "table",
  table: "table",
  chair: "chair",
  sofa: "sofa",
  floor: "ground",
  wall: "wall",
  pillar: "pillar",
};

const SEMANTIC_SIZE: Record<string, [number, number, number]> = {
  // Whole-object box includes the raised headboard represented by the existing bed preset.
  bed: [2, 1.2, 2.2],
  bookshelf: [0.9, 1.8, 0.35],
  cabinet: [0.9, 1.2, 0.4],
  curtain: [1.6, 1.8, 0.08],
  window: [1.4, 1.5, 0.08],
  door: [0.9, 2.05, 0.08],
  desk: [1.4, 0.75, 0.7],
  table: [1.2, 0.75, 0.7],
  chair: [0.48, 0.9, 0.48],
  sofa: [2, 0.8, 0.9],
  rug: [2, 0.03, 1.5],
  nightstand: [0.5, 0.55, 0.4],
  table_lamp: [0.25, 0.45, 0.25],
  potted_plant: [0.45, 0.8, 0.45],
};

// Bounded general priors prevent an image's relative pixel height from making
// common tabletop vessels and ornaments taller than their support furniture.
const UPRIGHT_SEMANTIC_HEIGHT_METERS: Record<string, number> = {
  sculpture: 1.2,
  container: 0.55,
  candlestick: 0.38,
  lantern: 0.45,
};

const FLAT_DECORATION_PATTERN = /(^|[\s_-])(rug|mat|carpet|tatami|cushion|pillow|seat|seat_pad|floor_cover|blanket|throw|tablecloth|table_cloth|table_cover|cloth|sheet|duvet|coverlet|bedspread|towel)([\s_-]|$)|地毯|地垫|坐垫|靠垫|枕头|毯|床单|被子|桌布|盖布/i;
const UPRIGHT_SEMANTIC_PATTERN = /(^|[\s_-])(statue|sculpture|buddha|idol|vase|lamp|lantern|candle|bottle|figure|plant|urn|censer|incense_burner)([\s_-]|$)|佛像|雕像|塑像|花瓶|灯|烛台|植物|花盆|香炉|香薰炉/i;

function isFlatDecorationSemantic(value: string | undefined) {
  return FLAT_DECORATION_PATTERN.test(value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().slice(0, MAX_ID_LENGTH).replace(/[^a-zA-Z0-9_-]/g, "_");
  return id || null;
}

function normalizedBox(value: unknown): NormalizedImageBox | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  const [left, top, right, bottom] = value as number[];
  if (left < 0 || top < 0 || right > 1 || bottom > 1 || right <= left || bottom <= top) return null;
  return [left, top, right, bottom];
}

function normalizedPoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  const [x, y] = value as number[];
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
}

function parseGeometryEvidence(value: unknown): ReferenceGroundEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.axes) || value.axes.length > 3) throw new ImageObservationValidationError("geometryEvidence 格式无效");
  const axes = value.axes.map((raw) => {
    if (!isRecord(raw) || !["lateral", "depth", "vertical"].includes(String(raw.axis)) || !Array.isArray(raw.segments) || raw.segments.length > MAX_GROUND_LINES_PER_AXIS) {
      throw new ImageObservationValidationError("geometryEvidence.axes 无效");
    }
    const segments = raw.segments.map((segment) => {
      if (!isRecord(segment)) throw new ImageObservationValidationError("透视线段格式无效");
      const start = normalizedPoint(segment.start), end = normalizedPoint(segment.end), score = confidence(segment.confidence);
      if (!start || !end || score === null || Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.025) throw new ImageObservationValidationError("透视线段超出范围或置信度无效");
      return { start, end, confidence: score };
    });
    return { axis: raw.axis as "lateral" | "depth" | "vertical", segments };
  });
  if (new Set(axes.map((axis) => axis.axis)).size !== axes.length) throw new ImageObservationValidationError("geometryEvidence 轴不能重复");
  return { axes };
}

function parseGroundContacts(value: unknown): GroundContactEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_GROUND_CONTACTS) throw new ImageObservationValidationError("groundContacts 数量无效");
  return value.map((raw) => {
    if (!isRecord(raw)) throw new ImageObservationValidationError("groundContact 格式无效");
    const point = normalizedPoint(raw.point), score = confidence(raw.confidence);
    if (!point || !["center", "corner", "edge"].includes(String(raw.kind)) || !["visible", "inferred"].includes(String(raw.visibility)) || score === null) {
      throw new ImageObservationValidationError("groundContact 字段无效");
    }
    return { point, kind: raw.kind as GroundContactEvidence["kind"], visibility: raw.visibility as GroundContactEvidence["visibility"], confidence: score };
  });
}

function parseGroundFootprints(value: unknown): NonNullable<ImageObservationItem["groundFootprints"]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_GROUND_FOOTPRINTS) throw new ImageObservationValidationError("groundFootprints 数量无效");
  const parseLoop = (raw: unknown, max: number, label: string) => {
    if (!Array.isArray(raw) || raw.length < 3 || raw.length > max) throw new ImageObservationValidationError(`${label} 顶点数量无效`);
    const points = raw.map(normalizedPoint);
    if (points.some((point) => !point)) throw new ImageObservationValidationError(`${label} 坐标无效`);
    const parsed = points as [number, number][];
    let area = 0;
    const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const onSegment = (a: [number, number], b: [number, number], point: [number, number]) => Math.abs(cross(a, b, point)) <= 1e-10
      && point[0] >= Math.min(a[0], b[0]) - 1e-10 && point[0] <= Math.max(a[0], b[0]) + 1e-10
      && point[1] >= Math.min(a[1], b[1]) - 1e-10 && point[1] <= Math.max(a[1], b[1]) + 1e-10;
    const segmentsIntersect = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
      const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
      if (((abC > 1e-10 && abD < -1e-10) || (abC < -1e-10 && abD > 1e-10))
        && ((cdA > 1e-10 && cdB < -1e-10) || (cdA < -1e-10 && cdB > 1e-10))) return true;
      return Math.abs(abC) <= 1e-10 && onSegment(a, b, c)
        || Math.abs(abD) <= 1e-10 && onSegment(a, b, d)
        || Math.abs(cdA) <= 1e-10 && onSegment(c, d, a)
        || Math.abs(cdB) <= 1e-10 && onSegment(c, d, b);
    };
    for (let index = 0; index < parsed.length; index += 1) {
      const a = parsed[index], b = parsed[(index + 1) % parsed.length];
      area += a[0] * b[1] - b[0] * a[1];
      for (let other = index + 1; other < parsed.length; other += 1) {
        if (other === index || other === (index + 1) % parsed.length || (other + 1) % parsed.length === index) continue;
        if (segmentsIntersect(a, b, parsed[other], parsed[(other + 1) % parsed.length])) throw new ImageObservationValidationError(`${label} 轮廓自交`);
      }
    }
    if (Math.abs(area) < 1e-5) throw new ImageObservationValidationError(`${label} 面积过小`);
    return parsed;
  };
  return value.map((raw, index) => {
    if (!isRecord(raw) || !["visible", "inferred"].includes(String(raw.visibility))) throw new ImageObservationValidationError(`groundFootprints[${index}] 格式无效`);
    const score = confidence(raw.confidence);
    const rawHoles = raw.holes === undefined ? [] : raw.holes;
    if (score === null || !Array.isArray(rawHoles) || rawHoles.length > 2) throw new ImageObservationValidationError(`groundFootprints[${index}] 置信度或孔洞无效`);
    const outer = parseLoop(raw.outer, 16, "groundFootprints.outer");
    const holes = (rawHoles as unknown[]).map((hole: unknown) => parseLoop(hole, 12, "groundFootprints.hole"));
    for (let holeIndex = 0; holeIndex < holes.length; holeIndex += 1) {
      const hole = holes[holeIndex];
      if (!hole.every(([x, y]) => pointInLoop(x, y, outer))) throw new ImageObservationValidationError("groundFootprints.hole 必须完整位于 outer 内，L形外部缺口不能编码为孔洞");
      for (let index = 0; index < hole.length; index += 1) {
        const a = hole[index], b = hole[(index + 1) % hole.length];
        for (let outerIndex = 0; outerIndex < outer.length; outerIndex += 1) {
          const c = outer[outerIndex], d = outer[(outerIndex + 1) % outer.length];
          if (imageSegmentsIntersect(a, b, c, d)) throw new ImageObservationValidationError("groundFootprints.hole 不能接触 outer 边界");
        }
      }
      for (const other of holes.slice(holeIndex + 1)) if (imageLoopsIntersect(hole, other)
        || pointInLoop(hole[0][0], hole[0][1], other) || pointInLoop(other[0][0], other[0][1], hole)) throw new ImageObservationValidationError("groundFootprints.hole 不能互相重叠");
    }
    return { outer, ...(holes.length ? { holes } : {}), visibility: raw.visibility as "visible" | "inferred", confidence: score };
  });
}

function confidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function validColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : undefined;
}

function colorOf(raw: Record<string, unknown>) {
  const appearance = isRecord(raw.appearance) ? raw.appearance : undefined;
  return validColor(raw.mainColor) ?? validColor(raw.color) ?? validColor(appearance?.color);
}

function parseObservation(input: unknown): ImageObservation {
  if (!isRecord(input) || !Array.isArray(input.surfaces) || !Array.isArray(input.items)
    || (input.people !== undefined && !Array.isArray(input.people))) {
    throw new ImageObservationValidationError("图像观察结果缺少 surfaces/items 数组");
  }
  if (input.surfaces.length > MAX_SURFACES || input.items.length > MAX_ITEMS || input.surfaces.length + input.items.length > MAX_ITEMS
    || (input.people?.length ?? 0) > 8) {
    throw new ImageObservationValidationError(`图像观察对象不能超过 ${MAX_ITEMS} 项`);
  }
  const geometryEvidence = parseGeometryEvidence(input.geometryEvidence);
  const seen = new Set<string>();
  const parseBase = (raw: unknown, label: string) => {
    if (!isRecord(raw)) throw new ImageObservationValidationError(`${label}格式无效`);
    const id = boundedId(raw.id);
    const bbox = normalizedBox(raw.bbox);
    const score = confidence(raw.confidence);
    if (!id || seen.has(id) || !bbox || score === null) throw new ImageObservationValidationError(`${label}的 id、bbox 或 confidence 无效`);
    seen.add(id);
    return { raw, id, bbox, confidence: score };
  };

  const surfaces = input.surfaces.map((raw, index) => {
    const base = parseBase(raw, `surface ${index + 1}`);
    if (base.raw.kind !== "wall" && base.raw.kind !== "floor") throw new ImageObservationValidationError("surface kind 仅支持 wall/floor");
    const sides: ImageSurfaceSide[] = ["image_left", "image_right", "image_back", "floor", "unknown"];
    if (!sides.includes(base.raw.side as ImageSurfaceSide)) throw new ImageObservationValidationError("surface side 无效");
    if (base.raw.kind === "wall" && base.raw.side === "floor") throw new ImageObservationValidationError("wall 不能使用 floor side");
    return {
      id: base.id,
      kind: base.raw.kind,
      side: base.raw.side as ImageSurfaceSide,
      bbox: base.bbox,
      confidence: base.confidence,
      visibility: parseVisibility(base.raw.visibility),
      mainColor: colorOf(base.raw),
    } satisfies ImageObservationSurface;
  });
  const items = input.items.map((raw, index) => {
    const base = parseBase(raw, `item ${index + 1}`);
    if (typeof base.raw.name !== "string" || !base.raw.name.trim() || base.raw.name.length > 80) {
      throw new ImageObservationValidationError(`item ${index + 1} name 无效`);
    }
    const semanticType = typeof base.raw.semanticType === "string"
      ? base.raw.semanticType.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, 48) || undefined
      : undefined;
    const category = base.raw.category;
    if (category !== undefined && !["ground", "wall", "door", "window", "table", "chair", "sofa", "cabinet", "pillar", "prop"].includes(String(category))) {
      throw new ImageObservationValidationError(`item ${index + 1} category 无效`);
    }
    if (!semanticType && category === undefined) throw new ImageObservationValidationError(`item ${index + 1} 缺少 category/semanticType`);
    if (base.raw.contactWallSide !== undefined && !["image_left", "image_right", "image_back", "unknown", "none"].includes(String(base.raw.contactWallSide))) {
      throw new ImageObservationValidationError(`item ${index + 1} contactWallSide 无效`);
    }
    if (base.raw.bodyExtendsToward !== undefined && !["image_left", "image_right", "image_up", "image_down", "unknown"].includes(String(base.raw.bodyExtendsToward))) {
      throw new ImageObservationValidationError(`item ${index + 1} bodyExtendsToward 无效`);
    }
    if (base.raw.rearFeature !== undefined && (!isRecord(base.raw.rearFeature) || typeof base.raw.rearFeature.name !== "string"
      || !base.raw.rearFeature.name.trim() || base.raw.rearFeature.name.length > 80 || !normalizedBox(base.raw.rearFeature.bbox))) {
      throw new ImageObservationValidationError(`item ${index + 1} rearFeature 无效`);
    }
    if (base.raw.placement !== undefined && !["wall_attached", "floor", "supported", "unknown"].includes(String(base.raw.placement))) {
      throw new ImageObservationValidationError(`item ${index + 1} placement 无效`);
    }
    if (base.raw.facingTowardId !== undefined && (typeof base.raw.facingTowardId !== "string"
      || !base.raw.facingTowardId.trim() || base.raw.facingTowardId.length > MAX_ID_LENGTH)) {
      throw new ImageObservationValidationError(`item ${index + 1} facingTowardId 无效`);
    }
    const visibleBbox = base.raw.visibleBbox === undefined ? undefined : normalizedBox(base.raw.visibleBbox) ?? undefined;
    const completeBbox = base.raw.completeBbox === undefined ? undefined : normalizedBox(base.raw.completeBbox) ?? undefined;
    if (base.raw.visibleBbox !== undefined && !visibleBbox || base.raw.completeBbox !== undefined && !completeBbox) throw new ImageObservationValidationError(`item ${index + 1} visibleBbox/completeBbox 无效`);
    const groundContacts = parseGroundContacts(base.raw.groundContacts);
    const groundFootprints = parseGroundFootprints(base.raw.groundFootprints);
    const occludesIds = base.raw.occludesIds === undefined ? undefined
      : Array.isArray(base.raw.occludesIds) && base.raw.occludesIds.length <= 12 && base.raw.occludesIds.every((id) => boundedId(id))
        ? base.raw.occludesIds.map((id) => boundedId(id)!) : (() => { throw new ImageObservationValidationError(`item ${index + 1} occludesIds 无效`); })();
    return {
      id: base.id,
      name: base.raw.name.trim(),
      ...(category ? { category: category as DirectorLayoutCategory } : {}),
      ...(semanticType ? { semanticType } : {}),
      bbox: base.bbox,
      confidence: base.confidence,
      visibility: parseVisibility(base.raw.visibility),
      mainColor: colorOf(base.raw),
      againstSurfaceId: boundedId(base.raw.againstSurfaceId) ?? undefined,
      contactWallSide: ["image_left", "image_right", "image_back", "unknown", "none"].includes(String(base.raw.contactWallSide))
        ? base.raw.contactWallSide as ContactWallSide : undefined,
      rearFeature: isRecord(base.raw.rearFeature) && typeof base.raw.rearFeature.name === "string"
        && base.raw.rearFeature.name.trim().length > 0 && base.raw.rearFeature.name.length <= 80
        && normalizedBox(base.raw.rearFeature.bbox)
        ? { name: base.raw.rearFeature.name.trim(), bbox: normalizedBox(base.raw.rearFeature.bbox)! } : undefined,
      bodyExtendsToward: ["image_left", "image_right", "image_up", "image_down", "unknown"].includes(String(base.raw.bodyExtendsToward))
        ? base.raw.bodyExtendsToward as ImageScreenDirection : undefined,
      supportId: boundedId(base.raw.supportId) ?? undefined,
      partOfId: boundedId(base.raw.partOfId) ?? undefined,
      placement: ["wall_attached", "floor", "supported", "unknown"].includes(String(base.raw.placement))
        ? base.raw.placement as ImageItemPlacement : undefined,
      facingTowardId: boundedId(base.raw.facingTowardId) ?? undefined,
      groundContacts,
      groundFootprints,
      visibleBbox,
      completeBbox,
      occludesIds,
    } satisfies ImageObservationItem;
  });
  const people = (input.people as unknown[] | undefined ?? []).map((raw, index) => {
    const base = parseBase(raw, `person ${index + 1}`);
    if (typeof base.raw.name !== "string" || !base.raw.name.trim() || base.raw.name.length > 80) {
      throw new ImageObservationValidationError(`person ${index + 1} name 无效`);
    }
    const posture = base.raw.posture;
    if (posture !== undefined && !["stand", "sit", "crouch", "kneel", "lie", "unknown"].includes(String(posture))) {
      throw new ImageObservationValidationError(`person ${index + 1} posture 无效`);
    }
    const facingDirection = base.raw.facingDirection;
    if (facingDirection !== undefined && !["image_left", "image_right", "toward_camera", "away_from_camera", "unknown", "image_up", "image_down"].includes(String(facingDirection))) {
      throw new ImageObservationValidationError(`person ${index + 1} facingDirection 无效`);
    }
    const kneelVariant = base.raw.kneelVariant;
    if (kneelVariant !== undefined && (base.raw.visibility !== "visible" || posture !== "kneel" || !["one-knee", "two-knee", "seiza"].includes(String(kneelVariant)))) {
      throw new ImageObservationValidationError(`person ${index + 1} kneelVariant 无效`);
    }
    if (base.raw.visibility === "visible" && posture === "kneel" && !["one-knee", "two-knee", "seiza"].includes(String(kneelVariant))) {
      throw new ImageObservationValidationError(`person ${index + 1} kneelVariant 缺失`);
    }
    const handGesture = base.raw.handGesture;
    if (handGesture !== undefined && (base.raw.visibility !== "visible" || handGesture !== "prayer")) {
      throw new ImageObservationValidationError(`person ${index + 1} handGesture 无效`);
    }
    return {
      id: base.id,
      name: base.raw.name.trim(),
      bbox: base.bbox,
      confidence: base.confidence,
      visibility: parseVisibility(base.raw.visibility),
      posture: (posture ?? "unknown") as NonNullable<ImageObservationPerson["posture"]>,
      facingDirection: (facingDirection ?? "unknown") as NonNullable<ImageObservationPerson["facingDirection"]>,
      ...(kneelVariant ? { kneelVariant: kneelVariant as ImageObservationPerson["kneelVariant"] } : {}),
      ...(handGesture ? { handGesture: handGesture as ImageObservationPerson["handGesture"] } : {}),
      supportId: boundedId(base.raw.supportId) ?? undefined,
    } satisfies ImageObservationPerson;
  });
  const allowedSpaceTypes = ["enclosed", "open", "outdoor", "unknown"];
  if (input.spaceType !== undefined && !allowedSpaceTypes.includes(String(input.spaceType))) {
    throw new ImageObservationValidationError("spaceType 无效");
  }
  const aspect = input.imageAspectRatio;
  if (aspect !== undefined && (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect < 0.1 || aspect > 10)) {
    throw new ImageObservationValidationError("imageAspectRatio 超出范围");
  }
  return {
    ...(input.spaceType ? { spaceType: input.spaceType as LayoutSpaceType } : { spaceType: "unknown" as const }),
    ...(typeof aspect === "number" ? { imageAspectRatio: aspect } : {}),
    ...(geometryEvidence ? { geometryEvidence } : {}),
    surfaces,
    items,
    ...(people.length ? { people } : {}),
  };
}

export function normalizeImageObservation(input: unknown): ImageObservation {
  return parseObservation(input);
}

function parseVisibility(value: unknown): ImageVisibility {
  return ["visible", "partly_occluded", "occluded", "uncertain"].includes(String(value))
    ? value as ImageVisibility
    : "uncertain";
}

function observationState(visibility: ImageVisibility) {
  if (visibility === "visible") return "visible" as const;
  if (visibility === "occluded") return "occluded" as const;
  return "ambiguous" as const;
}

function isVisible(visibility: ImageVisibility) {
  return visibility === "visible" || visibility === "partly_occluded";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function center(box: NormalizedImageBox) {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] as const;
}

function facingYawForCamera(direction: NonNullable<ImageObservationPerson["facingDirection"]>, camera: { position: [number, number, number]; target: [number, number, number] } | undefined) {
  const forward = camera
    ? [camera.target[0] - camera.position[0], 0, camera.target[2] - camera.position[2]]
    : [0, 0, -1];
  const length = Math.hypot(forward[0], forward[2]) || 1;
  forward[0] /= length;
  forward[2] /= length;
  const right = [-forward[2], 0, forward[0]];
  const directionVector = (() => {
    switch (direction) {
      case "image_left": return [-right[0], 0, -right[2]];
      case "image_right": return right;
      case "toward_camera": case "image_down": return [-forward[0], 0, -forward[2]];
      case "away_from_camera": case "image_up": return forward;
      default: return undefined;
    }
  })();
  return directionVector ? Math.atan2(directionVector[0], directionVector[2]) * 180 / Math.PI : 0;
}

function categoryFor(item: ImageObservationItem): DirectorLayoutCategory {
  const semantic = (item.semanticType ?? "").toLowerCase();
  const nameFallback = semantic.trim().length === 0;
  if (/(^|[\s_-])(curtain|drape|wall_art|painting|picture_frame|mirror|wall_mirror)([\s_-]|$)/i.test(semantic)
    || (nameFallback && /窗帘|纱帘|挂画|壁画|镜子/.test(item.name))) return "prop";
  if (item.category) return item.category;
  const profile = resolveLayoutSemanticProfile(semantic, item.name);
  if (profile) return profile.category;
  const known = SEMANTIC_CATEGORY[semantic];
  if (known) return known;
  return "prop";
}

function isLegacyWallDecoration(item: ImageObservationItem) {
  const semantic = item.semanticType?.trim() ?? "";
  if (semantic) return /(^|[\s_-])(curtain|drape|wall_art|painting|picture_frame|mirror|wall_mirror|wall_lamp)([\s_-]|$)/i.test(semantic);
  return /窗帘|纱帘|挂画|壁画|镜子|壁灯/.test(item.name);
}

function itemDescriptor(item: ImageObservationItem) {
  return item.semanticType?.trim() || item.name;
}

function semanticCategoryConflict(item: ImageObservationItem, category: DirectorLayoutCategory) {
  if (!item.category) return false;
  // Curtain was historically misreported as a window category; keep that
  // compatibility while treating other category/identity conflicts as review.
  const profile = resolveLayoutSemanticProfile(item.semanticType, item.semanticType ? undefined : item.name);
  if (profile?.canonicalType.toLowerCase() === "curtain" && category === "prop") return false;
  return Boolean(profile && profile.category !== category);
}

function effectivePlacement(item: ImageObservationItem): ImageItemPlacement {
  if (item.placement && item.placement !== "unknown") return item.placement;
  if (item.placement === "unknown") return "unknown";
  return isLegacyWallDecoration(item) ? "wall_attached" : "unknown";
}

function dimensionsFor(item: ImageObservationItem, sourceAspectRatio: number): [number, number, number] {
  const profile = resolveLayoutSemanticProfile(item.semanticType, item.category ? undefined : item.name);
  const category = categoryFor(item);
  const profileConflictsWithCategory = semanticCategoryConflict(item, category);
  const effectiveProfile = profileConflictsWithCategory ? undefined : profile;
  const descriptor = itemDescriptor(item);
  const flat = !profileConflictsWithCategory && isFlatDecorationSemantic(descriptor);
  const preset = profileConflictsWithCategory
    ? undefined
    : effectiveProfile?.canonicalType === "table" ? undefined : SEMANTIC_SIZE[effectiveProfile?.canonicalType ?? item.semanticType ?? ""];
  if (preset && !flat) return [...preset];
  const screenHeight = item.bbox[3] - item.bbox[1];
  const screenWidth = (item.bbox[2] - item.bbox[0]) * sourceAspectRatio;
  const rawWidth = clamp(screenWidth * METERS_PER_IMAGE_EXTENT, 0.25, 3.5);
  const widthLimits: Partial<Record<DirectorLayoutCategory, [number, number]>> = {
    table: [0.35, 3.5], chair: [0.3, 1.5], sofa: [0.6, 3.5], cabinet: [0.3, 2.8], door: [0.55, 1.6], window: [0.4, 3.5],
  };
  const [minWidth, maxWidth] = widthLimits[category] ?? [0.25, 3.5];
  const width = clamp(rawWidth, minWidth, maxWidth);
  const semantic = (item.semanticType ?? "").toLowerCase();
  const estimatedHeight = clamp(screenHeight * METERS_PER_IMAGE_EXTENT, 0.25, ROOM_HEIGHT_METERS);
  const estimatedDepth = clamp(estimatedHeight * 0.35, 0.25, 1.2);
  if (category === "pillar") {
    const radius = clamp(width, 0.25, 0.9);
    return [radius, ROOM_HEIGHT_METERS, radius];
  }
  if (flat) return [width, 0.08, clamp(width * 0.67, 0.25, 2.5)];
  // Keep upright semantic objects upright even when perspective or bbox noise makes
  // their image width approach their image height. Depth comes from a bounded prior,
  // never from the image-space vertical extent.
  if (!profileConflictsWithCategory && UPRIGHT_SEMANTIC_PATTERN.test(descriptor)) {
    const canonicalType = effectiveProfile?.canonicalType ?? semantic;
    const semanticHeight = UPRIGHT_SEMANTIC_HEIGHT_METERS[canonicalType];
    const height = semanticHeight ?? clamp(estimatedHeight, 0.5, ROOM_HEIGHT_METERS);
    const widthFromImageRatio = clamp(height * screenWidth / Math.max(0.01, screenHeight), 0.25, 3.5);
    return [widthFromImageRatio, height, clamp(height * 0.25, 0.25, 0.8)];
  }
  const heightByCategory: Partial<Record<DirectorLayoutCategory, number>> = {
    ground: 0.03, table: 0.75, chair: 0.9, sofa: 0.8, cabinet: 1.2, door: 2.05, window: 1.5, pillar: ROOM_HEIGHT_METERS, prop: 0.5,
  };
  if (effectiveProfile?.canonicalType === "table") return [width, 0.75, 0.7];
  if (category === "prop") {
    return [width, estimatedHeight, estimatedDepth];
  }
  const depthByCategory: Partial<Record<DirectorLayoutCategory, number>> = {
    ground: clamp(width * 0.67, 0.25, 2.5), table: 0.7, chair: 0.48, sofa: 0.9, cabinet: 0.4, door: 0.08, window: 0.08,
  };
  return [width, heightByCategory[category] ?? 0.5, depthByCategory[category] ?? estimatedDepth];
}

function wallDimensions(surface: ImageObservationSurface, spaceType: LayoutSpaceType): [number, number, number] | null {
  const widthInImage = surface.bbox[2] - surface.bbox[0];
  const heightInImage = surface.bbox[3] - surface.bbox[1];
  if (surface.side === "image_back") return [spaceType === "enclosed" ? ROOM_WIDTH_METERS : clamp(widthInImage * ROOM_WIDTH_METERS, 1, ROOM_WIDTH_METERS), ROOM_HEIGHT_METERS, WALL_THICKNESS_METERS];
  if (surface.side === "image_left" || surface.side === "image_right") {
    return [WALL_THICKNESS_METERS, ROOM_HEIGHT_METERS, spaceType === "enclosed" ? ROOM_DEPTH_METERS : clamp(heightInImage * ROOM_DEPTH_METERS, 1, ROOM_DEPTH_METERS)];
  }
  return null;
}

function wallPosition(surface: ImageObservationSurface, size: [number, number, number], spaceType: LayoutSpaceType): [number, number, number] {
  const [cx, cy] = center(surface.bbox);
  if (surface.side === "image_back") return [spaceType === "enclosed" ? 0 : clamp((cx - 0.5) * ROOM_WIDTH_METERS, -ROOM_WIDTH_METERS / 2 + size[0] / 2, ROOM_WIDTH_METERS / 2 - size[0] / 2), 0, -ROOM_DEPTH_METERS / 2];
  return [surface.side === "image_right" ? ROOM_WIDTH_METERS / 2 : -ROOM_WIDTH_METERS / 2, 0, spaceType === "enclosed" ? 0 : (cy - 0.5) * ROOM_DEPTH_METERS];
}

function wallYaw(side: ImageSurfaceSide) {
  if (side === "image_right") return -90;
  if (side === "image_left") return 90;
  return 0;
}

function positionAlongObservedWall(item: ImageObservationItem, surface: ImageObservationSurface, wallSize: [number, number, number]) {
  const [cx, cy] = center(item.bbox);
  const [wallCenterX, wallCenterY] = center(surface.bbox);
  const ratio = surface.side === "image_back"
    ? (cx - wallCenterX) / Math.max(0.05, surface.bbox[2] - surface.bbox[0])
    : (cy - wallCenterY) / Math.max(0.05, surface.bbox[3] - surface.bbox[1]);
  const halfSpan = surface.side === "image_back" ? wallSize[0] / 2 : wallSize[2] / 2;
  return clamp(ratio * halfSpan * 2, -halfSpan, halfSpan);
}

function positionAtWallInterior(surface: ImageObservationSurface, wallSize: [number, number, number], halfDepth: number, along: number) {
  const wallHalfThickness = (surface.side === "image_back" ? wallSize[2] : wallSize[0]) / 2;
  if (surface.side === "image_right") return [ROOM_WIDTH_METERS / 2 - wallHalfThickness - halfDepth - ATTACHMENT_GAP_METERS, 0, along] as [number, number, number];
  if (surface.side === "image_left") return [-ROOM_WIDTH_METERS / 2 + wallHalfThickness + halfDepth + ATTACHMENT_GAP_METERS, 0, along] as [number, number, number];
  return [along, 0, -ROOM_DEPTH_METERS / 2 + wallHalfThickness + halfDepth + ATTACHMENT_GAP_METERS] as [number, number, number];
}

function positionOnWall(item: ImageObservationItem, surface: ImageObservationSurface, wallSize: [number, number, number], size: [number, number, number]) {
  const [cx, cy] = center(item.bbox);
  const [wallCenterX, wallCenterY] = center(surface.bbox);
  const horizontalSpan = Math.max(0.05, surface.bbox[2] - surface.bbox[0]);
  const verticalSpan = Math.max(0.05, surface.bbox[3] - surface.bbox[1]);
  const horizontalRatio = surface.side === "image_back"
    ? (cx - wallCenterX) / horizontalSpan
    : (cy - wallCenterY) / verticalSpan;
  const alongHalfSpan = surface.side === "image_back" ? wallSize[0] / 2 : wallSize[2] / 2;
  const boundedHalfSpan = Math.max(0, alongHalfSpan - size[0] / 2);
  const along = clamp(horizontalRatio * alongHalfSpan * 2, -boundedHalfSpan, boundedHalfSpan);
  const verticalRatio = clamp((cy - surface.bbox[1]) / verticalSpan, 0, 1);
  const centerY = clamp((1 - verticalRatio) * wallSize[1], size[1] / 2, wallSize[1] - size[1] / 2);
  const bottomY = centerY - size[1] / 2;
  const base = positionAtWallInterior(surface, wallSize, size[2] / 2, along);
  return [base[0], bottomY, base[2]] as [number, number, number];
}

function worldZHalfExtent(size: [number, number, number], yawDegrees: number) {
  const radians = yawDegrees * Math.PI / 180;
  return Math.abs(Math.sin(radians)) * size[0] / 2 + Math.abs(Math.cos(radians)) * size[2] / 2;
}

function worldXHalfExtent(size: [number, number, number], yawDegrees: number) {
  const radians = yawDegrees * Math.PI / 180;
  return Math.abs(Math.cos(radians)) * size[0] / 2 + Math.abs(Math.sin(radians)) * size[2] / 2;
}

function imageGroundContactZ(item: ImageObservationItem, floor: ImageObservationSurface | undefined) {
  const floorTop = floor?.bbox[1] ?? 0;
  const floorBottom = floor?.bbox[3] ?? 1;
  const span = Math.max(0.05, floorBottom - floorTop);
  const ratio = clamp((item.bbox[3] - floorTop) / span, 0, 1);
  return -ROOM_DEPTH_METERS / 2 + ratio * ROOM_DEPTH_METERS;
}

export interface CameraFitPair {
  bbox: NormalizedImageBox;
  confidence: number;
  component: LayoutDraftComponent;
  surfaceSide?: ImageSurfaceSide;
  onGround?: boolean;
  groundContacts?: ImageObservationItem["groundContacts"];
  groundFootprints?: ImageObservationItem["groundFootprints"];
  occludesIds?: string[];
  groundCamera?: CalibratedGroundCamera["camera"];
  geometryEvidence?: ReferenceGroundEvidence;
}

function cameraWorldGeometry(component: LayoutDraftComponent) {
  const radians = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
  const toWorld = (x: number, y: number, z: number): [number, number, number] => {
    const localX = (x - 0.5) * component.size[0];
    const localZ = (z - 0.5) * component.size[2];
    return [
      component.position[0] + Math.cos(radians) * localX + Math.sin(radians) * localZ,
      component.position[1] + y * component.size[1],
      component.position[2] - Math.sin(radians) * localX + Math.cos(radians) * localZ,
    ];
  };
  const observedPrisms = deriveObservedAssemblyPrisms(component.groundFootprint, getLayoutComponentAssembly(component));
  if (observedPrisms?.length) return {
    points: observedPrisms.flatMap((prism) => prism.polygon.flatMap(([x, z]) => [
      toWorld(x, prism.yMin, z), toWorld(x, prism.yMax, z),
    ])),
    source: "observed-assembly-prisms" as const,
  };
  const centerY = component.position[1] + component.size[1] / 2;
  return {
    points: [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => {
    const localX = sx * component.size[0] / 2;
    const localZ = sz * component.size[2] / 2;
    return [
      component.position[0] + Math.cos(radians) * localX + Math.sin(radians) * localZ,
      centerY + sy * component.size[1] / 2,
      component.position[2] - Math.sin(radians) * localX + Math.cos(radians) * localZ,
    ] as const;
    }))),
    source: "component-bounds-fallback" as const,
  };
}

export function cameraWorldCorners(component: LayoutDraftComponent) {
  return cameraWorldGeometry(component).points;
}

export function cameraFitBreakdown(pairs: readonly CameraFitPair[], camera: { position: [number, number, number]; target: [number, number, number]; fov: number }, aspect: number) {
  const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const;
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const normalize = (v: readonly number[]) => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length] as const;
  };
  const forward = normalize(sub(camera.target, camera.position));
  const right = normalize([-forward[2], 0, forward[0]]);
  const up = normalize([
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]);
  const focalY = 0.5 / Math.tan(camera.fov * Math.PI / 360);
  let total = 0;
  let weightSum = 0;
  const pairDiagnostics: Array<{
    id: string;
    observedCenter: [number, number];
    observedSize: [number, number];
    predictedCenter: [number, number];
    predictedSize: [number, number];
    centerError: number;
    scaleError: number;
    widthResidual: number;
    heightResidual: number;
    widthLogScaleError: number;
    heightLogScaleError: number;
    weightedContribution: number;
    projectionGeometry: "observed-assembly-prisms" | "component-bounds-fallback";
  }> = [];
  for (const pair of pairs) {
    const geometry = cameraWorldGeometry(pair.component);
    const projected = geometry.points.map((corner) => {
      const relative = sub(corner, camera.position);
      const depth = dot(relative, forward);
      return depth > 0.1 ? [0.5 + dot(relative, right) * focalY / aspect / depth, 0.5 - dot(relative, up) * focalY / depth] as const : undefined;
    });
    if (projected.some((point) => !point)) return { error: Infinity, pairs: [] };
    const points = projected as Array<readonly [number, number]>;
    const left = Math.min(...points.map(([x]) => x));
    const rightEdge = Math.max(...points.map(([x]) => x));
    const top = Math.min(...points.map(([, y]) => y));
    const bottom = Math.max(...points.map(([, y]) => y));
    const observedWidth = Math.max(0.01, pair.bbox[2] - pair.bbox[0]);
    const observedHeight = Math.max(0.01, pair.bbox[3] - pair.bbox[1]);
    const predictedWidth = Math.max(0.01, rightEdge - left);
    const predictedHeight = Math.max(0.01, bottom - top);
    const centerError = Math.hypot((left + rightEdge - pair.bbox[0] - pair.bbox[2]) / 2, (top + bottom - pair.bbox[1] - pair.bbox[3]) / 2);
    const scaleError = Math.abs(Math.log(predictedWidth / observedWidth)) + Math.abs(Math.log(predictedHeight / observedHeight));
    const weight = Math.max(0.1, pair.confidence);
    const contribution = weight * (centerError + scaleError * 0.28);
    total += contribution;
    weightSum += weight;
    pairDiagnostics.push({
      id: pair.component.id,
      observedCenter: [(pair.bbox[0] + pair.bbox[2]) / 2, (pair.bbox[1] + pair.bbox[3]) / 2],
      observedSize: [observedWidth, observedHeight],
      predictedCenter: [(left + rightEdge) / 2, (top + bottom) / 2],
      predictedSize: [predictedWidth, predictedHeight],
      centerError,
      scaleError,
      widthResidual: rightEdge - left - observedWidth,
      heightResidual: bottom - top - observedHeight,
      widthLogScaleError: Math.log(predictedWidth / observedWidth),
      heightLogScaleError: Math.log(predictedHeight / observedHeight),
      weightedContribution: contribution,
      projectionGeometry: geometry.source,
    });
  }
  return {
    error: weightSum ? total / weightSum : Infinity,
    pairs: weightSum ? pairDiagnostics.map((item) => ({ ...item, weightedContribution: item.weightedContribution / weightSum })) : [],
  };
}

function dominantFitResiduals(pairs: readonly CameraFitPair[], diagnostics: ReturnType<typeof cameraFitBreakdown>["pairs"]) {
  const pairById = new Map(pairs.map((pair) => [pair.component.id, pair]));
  const ranked = [...diagnostics]
    .map((diagnostic) => ({ diagnostic, pair: pairById.get(diagnostic.id) }))
    .filter((item): item is { diagnostic: (typeof diagnostics)[number]; pair: CameraFitPair } => Boolean(item.pair))
    .sort((a, b) => b.diagnostic.weightedContribution - a.diagnostic.weightedContribution);
  const total = ranked.reduce((sum, item) => sum + item.diagnostic.weightedContribution, 0);
  if (!(total > 0)) return [];
  const selected: typeof ranked = [];
  let contribution = 0;
  for (const item of ranked) {
    if (selected.length >= 3) break;
    selected.push(item);
    contribution += item.diagnostic.weightedContribution;
    if (contribution >= total * 0.7) break;
  }
  return selected;
}

export function cameraFitError(pairs: readonly CameraFitPair[], camera: { position: [number, number, number]; target: [number, number, number]; fov: number }, aspect: number) {
  return cameraFitBreakdown(pairs, camera, aspect).error;
}

/** Direction-only line evidence used to retain a physically diverse camera seed.
 * A finite low error is supporting evidence, not a calibrated-camera claim. */
function cameraAxisDirectionError(pairs: readonly CameraFitPair[], camera: FitCamera, aspect: number) {
  const forwardVector = [camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]];
  const forwardLength = Math.hypot(...forwardVector) || 1;
  const forward = forwardVector.map((value) => value / forwardLength);
  const right = [-forward[2], 0, forward[0]];
  const rightLength = Math.hypot(...right) || 1;
  right[0] /= rightLength; right[2] /= rightLength;
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const worldAxis: Record<"lateral" | "depth" | "vertical", number[]> = { lateral: [1, 0, 0], depth: [0, 0, 1], vertical: [0, 1, 0] };
  let weight = 0, error = 0;
  const focal = 0.5 / Math.tan(camera.fov * Math.PI / 360);
  for (const evidence of pairs.flatMap((pair) => pair.geometryEvidence?.axes ?? [])) {
    const direction = worldAxis[evidence.axis];
    const cameraX = direction[0] * right[0] + direction[1] * right[1] + direction[2] * right[2];
    const cameraY = direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2];
    const cameraZ = direction[0] * forward[0] + direction[1] * forward[1] + direction[2] * forward[2];
    const vanishing = Math.abs(cameraZ) > 1e-4 ? [0.5 + cameraX / cameraZ * focal / aspect, 0.5 - cameraY / cameraZ * focal] : undefined;
    for (const segment of evidence.segments) {
      const observed = [segment.end[0] - segment.start[0], -(segment.end[1] - segment.start[1])];
      const observedLength = Math.hypot(...observed) || 1;
      const midpoint = [(segment.start[0] + segment.end[0]) / 2, (segment.start[1] + segment.end[1]) / 2];
      const predicted = vanishing
        ? [vanishing[0] - midpoint[0], -(vanishing[1] - midpoint[1])]
        : [cameraX, -cameraY];
      const predictedLength = Math.hypot(...predicted) || 1;
      const agreement = Math.abs((observed[0] * predicted[0] + observed[1] * predicted[1]) / (observedLength * predictedLength));
      error += segment.confidence * (1 - agreement);
      weight += segment.confidence;
    }
  }
  return weight ? error / weight : null;
}

type FitCamera = { position: [number, number, number]; target: [number, number, number]; fov: number };

/** Low-confidence camera seeds from a visible quadrilateral ground footprint. */
function footprintCameraSeeds(pairs: readonly CameraFitPair[], aspect: number, center: [number, number, number], distanceBase: number): FitCamera[] {
  const intersect = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]) => {
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
    const denominator = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(denominator) < 1e-5) return undefined;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denominator;
    const point: [number, number] = [a[0] + t * r[0], a[1] + t * r[1]];
    return point.every(Number.isFinite) && Math.abs(point[0]) < 32 && Math.abs(point[1]) < 32 ? point : undefined;
  };
  const candidates: FitCamera[] = [];
  for (const pair of pairs) {
    const footprint = pair.groundFootprints?.find((item) => item.visibility === "visible" && item.confidence >= 0.8 && item.outer.length === 4 && !item.holes?.length);
    if (!pair.onGround || pair.confidence < 0.8 || pair.component.confidence < 0.8 || !footprint) continue;
    const points = footprint.outer;
    const vpA = intersect(points[0], points[1], points[3], points[2]);
    const vpB = intersect(points[1], points[2], points[0], points[3]);
    if (!vpA || !vpB) continue;
    // Use aspect-scaled image coordinates so focal length is measured in image-height units.
    const ax = (vpA[0] - 0.5) * aspect, ay = 0.5 - vpA[1];
    const bx = (vpB[0] - 0.5) * aspect, by = 0.5 - vpB[1];
    const focalSquared = -(ax * bx + ay * by);
    if (!Number.isFinite(focalSquared) || focalSquared < 0.12 || focalSquared > 25) continue;
    const focal = Math.sqrt(focalSquared);
    // A level-roll camera maps both horizontal ground axes to one shared horizon.
    // Reject quads whose two VP families disagree beyond a conservative line-fit tolerance.
    if (Math.abs(vpA[1] - vpB[1]) > 0.035) continue;
    const horizonY = (vpA[1] + vpB[1]) / 2;
    const pitch = Math.atan2(0.5 - horizonY, focal);
    const fov = 2 * Math.atan(0.5 / focal) * 180 / Math.PI;
    if (!Number.isFinite(pitch) || pitch < 0.035 || pitch > 1.05 || fov < 12 || fov > 125) continue;
    // The two footprint axes are unlabeled. Try each as the camera-depth axis;
    // their ambiguity is retained as multiple low-confidence fit candidates.
    for (const [depthX, depthY] of [[ax, ay], [bx, by]] as const) {
      const yaw = Math.atan2(-depthX * Math.cos(pitch), focal);
      for (const cameraHeight of [1.1, 1.55, 2.1]) {
        const distance = Math.min(distanceBase * 12, cameraHeight / Math.sin(pitch));
        const forward: [number, number, number] = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
        const position: [number, number, number] = [center[0] - forward[0] * distance, center[1] + cameraHeight, center[2] - forward[2] * distance];
        const target: [number, number, number] = [center[0], position[1] + forward[1] * distance, center[2]];
        if (position.every(Number.isFinite) && target.every(Number.isFinite) && position[2] > target[2]) candidates.push({ position, target, fov });
      }
    }
  }
  return candidates;
}

function cameraCandidates(pairs: readonly CameraFitPair[], allComponents: readonly LayoutDraftComponent[], aspect: number, fallback?: LayoutDraft["referenceCamera"]): FitCamera[] {
  const corners = pairs.flatMap(({ component }) => cameraWorldCorners(component));
  if (!corners.length) return [];
  const min = [0, 1, 2].map((axis) => Math.min(...corners.map((point) => point[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...corners.map((point) => point[axis])));
  const distanceBase = Math.max(1, ...[0, 1, 2].map((axis) => max[axis] - min[axis]));
  const candidates: FitCamera[] = [];
  candidates.push(...footprintCameraSeeds(pairs, aspect, [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], distanceBase));
  const safeStart = (candidate: FitCamera) => candidate.position.every(Number.isFinite)
    && candidate.target.every(Number.isFinite) && Number.isFinite(candidate.fov)
    && candidate.fov >= 25 && candidate.fov <= 100
    && candidate.position[2] > candidate.target[2]
    && !cameraInsideGeometry(candidate.position, allComponents);
  if (fallback && safeStart(fallback)) candidates.push({ position: [...fallback.position], target: [...fallback.target], fov: fallback.fov });
  for (const pair of pairs) {
    const groundCamera = pair.groundCamera;
    if (groundCamera) {
      const candidate = { position: [...groundCamera.position] as [number, number, number], target: [...groundCamera.target] as [number, number, number], fov: groundCamera.fov };
      if (safeStart(candidate)) candidates.push(candidate);
    }
  }
  for (const azimuthDegrees of [-35, -20, 0, 20, 35]) {
    for (const distanceFactor of [0.6, 0.85, 1.1, 1.5]) {
      for (const pitchDegrees of [-5, 0, 5, 10, 15, 20, 25, 30]) {
        for (const fov of [35, 45, 55, 65, 75]) {
          const horizontalDistance = distanceBase * distanceFactor;
          const azimuth = azimuthDegrees * Math.PI / 180;
          const pitch = pitchDegrees * Math.PI / 180;
          const targetX = (min[0] + max[0]) / 2;
          const targetZ = (min[2] + max[2]) / 2;
          const cameraY = 1.6;
          const candidate: FitCamera = {
            position: [targetX + Math.sin(azimuth) * horizontalDistance, cameraY, targetZ + Math.cos(azimuth) * horizontalDistance],
            target: [targetX, cameraY - Math.tan(pitch) * horizontalDistance, targetZ],
            fov,
          };
          if (!cameraInsideGeometry(candidate.position, allComponents) && candidate.position[2] > targetZ) candidates.push(candidate);
        }
      }
    }
  }
  const sceneScale = Math.max(1, ...[0, 1, 2].map((axis) => max[axis] - min[axis]));
  const initialCollisions = fitCollisionPairs(allComponents, allComponents);
  const starts = candidates
    .filter(safeStart)
    .map((camera) => ({ camera, error: cameraFitError(pairs, camera, aspect)
      + sceneEvidenceError(pairs, camera, aspect, allComponents, sceneScale)
      + initialCollisions.filter((pair) => pair.classification !== "allowed").reduce((sum, pair) => sum + 0.12 * pair.penetrationMeters / sceneScale, 0) }))
    .sort((a, b) => a.error - b.error)
    .slice(0, 12);
  const refined = starts.map(({ camera }) => refineCameraCandidate(pairs, camera, aspect, allComponents, { min, max, sceneScale }));
  return [...candidates, ...refined];
}

function refineCameraCandidate(
  pairs: readonly CameraFitPair[],
  start: FitCamera,
  aspect: number,
  allComponents: readonly LayoutDraftComponent[],
  bounds: { min: number[]; max: number[]; sceneScale: number },
): FitCamera {
  const camera: FitCamera = { position: [...start.position], target: [...start.target], fov: start.fov };
  const value = (axis: number) => axis < 3 ? camera.position[axis] : axis < 6 ? camera.target[axis - 3] : camera.fov;
  const setValue = (axis: number, next: number) => {
    if (axis < 3) camera.position[axis] = next;
    else if (axis < 6) camera.target[axis - 3] = next;
    else camera.fov = next;
  };
  const lower = (axis: number) => axis === 1 ? 0.25 : axis === 4 ? Math.max(-0.5, bounds.min[1] - bounds.sceneScale) : axis === 6 ? 25 : (axis < 3 ? bounds.min[axis] - 3 * bounds.sceneScale : bounds.min[axis - 3] - 1.5 * bounds.sceneScale);
  const upper = (axis: number) => axis === 1 ? bounds.max[1] + 2 * bounds.sceneScale : axis === 4 ? bounds.max[1] + bounds.sceneScale : axis === 6 ? 100 : (axis < 3 ? bounds.max[axis] + 3 * bounds.sceneScale : bounds.max[axis - 3] + 1.5 * bounds.sceneScale);
  const safe = () => camera.position[2] > camera.target[2] && !cameraInsideGeometry(camera.position, allComponents);
  let bestError = safe() ? cameraFitError(pairs, camera, aspect) : Infinity;
  let step = bounds.sceneScale * 0.2;
  let fovStep = 8;
  for (let round = 0; round < 8; round++) {
    for (let axis = 0; axis < 7; axis++) {
      const original = value(axis);
      let axisBest = bestError;
      let axisValue = original;
      const delta = axis === 6 ? fovStep : step;
      for (const sign of [-1, 1]) {
        const candidateValue = clamp(original + sign * delta, lower(axis), upper(axis));
        if (candidateValue === original) continue;
        setValue(axis, candidateValue);
        if (safe()) {
          const error = cameraFitError(pairs, camera, aspect);
          if (error < axisBest) { axisBest = error; axisValue = candidateValue; }
        }
      }
      setValue(axis, axisValue);
      bestError = axisBest;
    }
    step *= 0.5;
    fovStep *= 0.5;
  }
  return camera;
}

function observedHorizontalOrderIsPreserved(pairs: readonly CameraFitPair[], components: readonly LayoutDraftComponent[], camera: FitCamera) {
  const fittedById = new Map(components.map((component) => [component.id, component]));
  const projectedCenterX = (component: LayoutDraftComponent) => {
    const forward = [camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]];
    const forwardLength = Math.hypot(...forward) || 1;
    const normalizedForward = forward.map((value) => value / forwardLength);
    const right = [-normalizedForward[2], 0, normalizedForward[0]];
    const rightLength = Math.hypot(right[0], right[2]) || 1;
    right[0] /= rightLength;
    right[2] /= rightLength;
    const relative = [component.position[0] - camera.position[0], component.position[1] + component.size[1] / 2 - camera.position[1], component.position[2] - camera.position[2]];
    const depth = relative[0] * normalizedForward[0] + relative[1] * normalizedForward[1] + relative[2] * normalizedForward[2];
    return depth > 0.1 ? (relative[0] * right[0] + relative[2] * right[2]) / depth : undefined;
  };
  for (let left = 0; left < pairs.length; left += 1) {
    const a = pairs[left];
    if (!a.onGround || a.confidence < 0.65 || !isMajorFitObject(a.component)) continue;
    for (let rightIndex = left + 1; rightIndex < pairs.length; rightIndex += 1) {
      const b = pairs[rightIndex];
      if (!b.onGround || b.confidence < 0.65 || !isMajorFitObject(b.component)) continue;
      const aCenter = (a.bbox[0] + a.bbox[2]) / 2;
      const bCenter = (b.bbox[0] + b.bbox[2]) / 2;
      const clearlySeparated = a.bbox[2] <= b.bbox[0] - 0.025 || b.bbox[2] <= a.bbox[0] - 0.025;
      if (!clearlySeparated) continue;
      const fittedA = fittedById.get(a.component.id) ?? a.component;
      const fittedB = fittedById.get(b.component.id) ?? b.component;
      const projectedA = projectedCenterX(fittedA);
      const projectedB = projectedCenterX(fittedB);
      if (projectedA === undefined || projectedB === undefined) return false;
      if (Math.sign(aCenter - bCenter) !== Math.sign(projectedA - projectedB)) return false;
    }
  }
  return true;
}

function isMajorFitObject(component: LayoutDraftComponent) {
  const semantic = `${component.semanticType ?? ""} ${component.name}`;
  const broadSurface = /(^|[\s_-])(rug|mat|carpet|tatami|floor_cover|tablecloth|table_cloth|table_cover|blanket|throw)([\s_-]|$)|地毯|地垫|榻榻米|桌布|盖布|毯子/i.test(semantic);
  return !["ground", "wall", "door", "window"].includes(component.category)
    && !broadSurface
    && (component.size[0] * component.size[2] >= 0.16 || component.size[1] >= 1)
    && component.confidence >= 0.65;
}

function introducesMajorOverlap(collisions: readonly FitCollisionPair[], original: readonly LayoutDraftComponent[], initial: readonly FitCollisionPair[] = []) {
  const byId = new Map(original.map((component) => [component.id, component]));
  const initialKeys = new Set(initial.map((collision) => [collision.firstId, collision.secondId].sort().join("\u0000")));
  return collisions.some((collision) => {
    if (collision.classification === "allowed") return false;
    if (initialKeys.has([collision.firstId, collision.secondId].sort().join("\u0000"))) return false;
    const first = byId.get(collision.firstId);
    const second = byId.get(collision.secondId);
    return !!first && !!second && isMajorFitObject(first) && isMajorFitObject(second);
  });
}

export function carryFittedParentMotion(
  fittedRoots: readonly LayoutDraftComponent[],
  allComponents: readonly LayoutDraftComponent[],
): { components: LayoutDraftComponent[]; movedComponentCount: number } {
  const originalById = new Map(allComponents.map((component) => [component.id, component]));
  const fittedById = new Map(fittedRoots.map((component) => [component.id, component]));
  const resultById = new Map(allComponents.map((component) => [component.id, component]));
  const parentOf = (component: LayoutDraftComponent) => component.supportComponentId ?? component.partOfComponentId;
  const depth = (component: LayoutDraftComponent, seen = new Set<string>()): number => {
    const parentId = parentOf(component);
    if (!parentId || seen.has(parentId)) return 0;
    const parent = originalById.get(parentId);
    if (!parent) return 0;
    seen.add(parentId);
    return 1 + depth(parent, seen);
  };
  const roots = [...fittedRoots].sort((a, b) => depth(a) - depth(b));
  const visited = new Set<string>();
  const visit = (parent: LayoutDraftComponent) => {
    const originalParent = originalById.get(parent.id);
    if (!originalParent) return;
    const delta = parent.position.map((value, index) => value - originalParent.position[index]) as [number, number, number];
    for (const child of allComponents.filter((component) => parentOf(component) === parent.id)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const fittedChild = fittedById.get(child.id);
      const supportHeightDelta = child.supportComponentId === parent.id
        ? getLayoutSupportTopY(parent, 0, child.position) - getLayoutSupportTopY(originalParent, 0, child.position)
        : 0;
      const childPosition = fittedChild?.position ?? child.position;
      const next = fittedChild
        ? { ...fittedChild, position: [fittedChild.position[0] + delta[0], child.supportComponentId === parent.id ? getLayoutSupportTopY(parent, 0, childPosition) : fittedChild.position[1] + delta[1] + supportHeightDelta, fittedChild.position[2] + delta[2]] as [number, number, number] }
        : {
          ...child,
          position: [child.position[0] + delta[0], child.supportComponentId === parent.id ? getLayoutSupportTopY(parent, 0, child.position) : child.position[1] + delta[1] + supportHeightDelta, child.position[2] + delta[2]] as [number, number, number],
        };
      resultById.set(child.id, next);
      visit(next);
    }
  };
  for (const root of roots) {
    resultById.set(root.id, root);
    visit(root);
  }
  const components = [...resultById.values()];
  const movedComponentCount = components.filter((component) => {
    const original = originalById.get(component.id);
    return original && Math.hypot(component.position[0] - original.position[0], component.position[1] - original.position[1], component.position[2] - original.position[2]) > 1e-4;
  }).length;
  return { components, movedComponentCount };
}

function getRoomBoundaryViolations(components: readonly LayoutDraftComponent[]) {
  const floor = components.find((component) => component.category === "ground");
  if (!floor) return [] as Array<{ componentId: string; edge: "left" | "right" | "front" | "back"; overflowMeters: number }>;
  const roomBounds = { minX: floor.position[0] - floor.size[0] / 2, maxX: floor.position[0] + floor.size[0] / 2, minZ: floor.position[2] - floor.size[2] / 2, maxZ: floor.position[2] + floor.size[2] / 2 };
  return components.flatMap((component) => {
    if (["ground", "wall", "door", "window"].includes(component.category)) return [];
    const yaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    const halfX = (Math.abs(Math.cos(yaw)) * component.size[0] + Math.abs(Math.sin(yaw)) * component.size[2]) / 2;
    const halfZ = (Math.abs(Math.sin(yaw)) * component.size[0] + Math.abs(Math.cos(yaw)) * component.size[2]) / 2;
    const bounds = [
      { edge: "left" as const, overflow: roomBounds.minX - (component.position[0] - halfX) },
      { edge: "right" as const, overflow: component.position[0] + halfX - roomBounds.maxX },
      { edge: "front" as const, overflow: roomBounds.minZ - (component.position[2] - halfZ) },
      { edge: "back" as const, overflow: component.position[2] + halfZ - roomBounds.maxZ },
    ];
    return bounds.filter((bound) => bound.overflow > 1e-4)
      .map((bound) => ({ componentId: component.id, edge: bound.edge, overflowMeters: bound.overflow }));
  });
}

function fitPairPenetration(a: LayoutDraftComponent, b: LayoutDraftComponent) {
  if (a.category === "ground" || b.category === "ground" || a.category === "wall" || b.category === "wall") return 0;
  const verticalOverlap = Math.min(a.position[1] + a.size[1], b.position[1] + b.size[1]) - Math.max(a.position[1], b.position[1]);
  if (verticalOverlap <= 0.02) return 0;
  const horizontalBounds = (component: LayoutDraftComponent) => {
    const yaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    // Ground-fit size is the XZ envelope of the accepted footprint. Every
    // observed prism is clipped to that normalized unit envelope, while the
    // default assembly is normalized to the same envelope before clipping.
    // This rotated rectangle is therefore a conservative AABB broad phase for
    // all rendered assembly prisms (including component yaw), never a tighter
    // unrelated primitive proxy that could reject a real prism intersection.
    const halfX = (Math.abs(Math.cos(yaw)) * component.size[0] + Math.abs(Math.sin(yaw)) * component.size[2]) / 2;
    const halfZ = (Math.abs(Math.sin(yaw)) * component.size[0] + Math.abs(Math.cos(yaw)) * component.size[2]) / 2;
    return { halfX, halfZ };
  };
  const boundsA = horizontalBounds(a), boundsB = horizontalBounds(b);
  if (Math.abs(a.position[0] - b.position[0]) >= boundsA.halfX + boundsB.halfX - 1e-5
    || Math.abs(a.position[2] - b.position[2]) >= boundsA.halfZ + boundsB.halfZ - 1e-5) return 0;
  type Prism = { polygon: [number, number][]; minY: number; maxY: number };
  const prisms = (component: LayoutDraftComponent): Prism[] => {
    const assembly = getLayoutComponentAssembly(component);
    const yaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    const toWorld = (point: readonly number[]): [number, number] => {
      const localX = (point[0] - 0.5) * component.size[0];
      const localZ = (point[1] - 0.5) * component.size[2];
      return [component.position[0] + Math.cos(yaw) * localX + Math.sin(yaw) * localZ, component.position[2] - Math.sin(yaw) * localX + Math.cos(yaw) * localZ];
    };
    const observed = deriveObservedAssemblyPrisms(component.groundFootprint, assembly);
    if (observed?.length) return observed.map((part) => ({
      polygon: part.polygon.map(toWorld),
      minY: component.position[1] + part.yMin * component.size[1],
      maxY: component.position[1] + part.yMax * component.size[1],
    }));
    const componentYaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    const transform = getLayoutAssemblyUnitBoundsTransform(assembly);
    const parts = assembly?.length && transform
      ? assembly.map((part) => ({
        centerX: transform.position[0] + part.position[0] * transform.scale[0],
        centerZ: transform.position[2] + part.position[2] * transform.scale[2],
        width: part.size[0] * transform.scale[0],
        depth: part.size[2] * transform.scale[2],
        y0: transform.position[1] + (part.position[1] - part.size[1] / 2) * transform.scale[1],
        y1: transform.position[1] + (part.position[1] + part.size[1] / 2) * transform.scale[1],
        angle: (part.rotation?.[1] ?? 0) * Math.PI / 180,
      }))
      : [{ centerX: 0.5, centerZ: 0.5, width: 1, depth: 1, y0: 0, y1: 1, angle: 0 }];
    return parts.map((part) => {
      const polygon: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
        const x = sx * part.width / 2, z = sz * part.depth / 2;
        const rx = part.centerX + Math.cos(part.angle) * x + Math.sin(part.angle) * z;
        const rz = part.centerZ - Math.sin(part.angle) * x + Math.cos(part.angle) * z;
        return toWorld([rx, rz]);
      });
      return { polygon, minY: component.position[1] + part.y0 * component.size[1], maxY: component.position[1] + part.y1 * component.size[1] };
    });
  };
  const project = (polygon: [number, number][], axis: [number, number]) => polygon.map(([x, z]) => x * axis[0] + z * axis[1]);
  const convexPenetration = (left: [number, number][], right: [number, number][]) => {
    let overlap = Infinity;
    for (const polygon of [left, right]) for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index], end = polygon[(index + 1) % polygon.length];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1;
      const axis: [number, number] = [-(end[1] - start[1]) / length, (end[0] - start[0]) / length];
      const aRange = project(left, axis), bRange = project(right, axis);
      const depth = Math.min(Math.max(...aRange), Math.max(...bRange)) - Math.max(Math.min(...aRange), Math.min(...bRange));
      if (depth <= 1e-5) return 0;
      overlap = Math.min(overlap, depth);
    }
    return overlap;
  };
  const firstPrisms = prisms(a), secondPrisms = prisms(b);
  return Math.max(0, ...firstPrisms.flatMap((first) => secondPrisms.map((second) => {
    const vertical = Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY);
    return vertical <= 0.02 ? 0 : Math.min(vertical, convexPenetration(first.polygon, second.polygon));
  })));
}

type FitCollisionPair = { firstId: string; secondId: string; classification: "hard" | "review" | "allowed"; reason: string; penetrationMeters: number };

type FitCollisionCounts = { totalCandidates: number; hard: number; review: number; allowed: number };

function summarizeFitCollisions(pairs: readonly FitCollisionPair[]): FitCollisionCounts {
  return {
    totalCandidates: pairs.length,
    hard: pairs.filter((pair) => pair.classification === "hard").length,
    review: pairs.filter((pair) => pair.classification === "review").length,
    allowed: pairs.filter((pair) => pair.classification === "allowed").length,
  };
}

function summarizeFitPenetration(pairs: readonly FitCollisionPair[]) {
  return pairs.filter((pair) => pair.classification !== "allowed")
    .reduce((sum, pair) => sum + pair.penetrationMeters, 0);
}

function hasAncestorRelation(left: LayoutDraftComponent, right: LayoutDraftComponent, byId: Map<string, LayoutDraftComponent>) {
  const ancestorIds = (component: LayoutDraftComponent) => {
    const ids = new Set<string>();
    let current: LayoutDraftComponent | undefined = component;
    while (current) {
      const parentId = current.supportComponentId ?? current.partOfComponentId;
      if (!parentId || ids.has(parentId)) break;
      ids.add(parentId);
      current = byId.get(parentId);
    }
    return ids;
  };
  return ancestorIds(left).has(right.id) || ancestorIds(right).has(left.id);
}

function isReliableRigidFitVolume(component: LayoutDraftComponent) {
  const descriptor = `${component.name} ${component.semanticType ?? ""}`;
  const softOrIrregular = /rug|carpet|mat|curtain|drape|plant|foliage|cloth|blanket|pillow|软|布|毯|帘|植物|绿植/i.test(descriptor);
  return component.primitive === "box" && component.uncertain === false && component.confidence >= 0.85
    && !softOrIrregular && !["ground", "wall", "door", "window"].includes(component.category);
}

function isGroundCoverComponent(component: LayoutDraftComponent) {
  return /(?:^|[\s_-])(rug|carpet|mat|floor_cover|tatami)(?:$|[\s_-])|地毯|地垫|地毡/i.test(`${component.name} ${component.semanticType ?? ""}`);
}

function fitCollisionPairs(allComponents: readonly LayoutDraftComponent[], fittedComponents: readonly LayoutDraftComponent[]): FitCollisionPair[] {
  const fittedById = new Map(fittedComponents.map((component) => [component.id, component]));
  const originalById = new Map(allComponents.map((component) => [component.id, component]));
  const visibleComponents = allComponents.filter((component) => component.visible !== false);
  const reports: FitCollisionPair[] = [];
  for (let left = 0; left < visibleComponents.length; left += 1) {
    const originalA = visibleComponents[left];
    const nextA = fittedById.get(originalA.id) ?? originalA;
    for (let right = left + 1; right < visibleComponents.length; right += 1) {
      const originalB = visibleComponents[right];
      const nextB = fittedById.get(originalB.id) ?? originalB;
      const penetrationMeters = fitPairPenetration(nextA, nextB);
      if (penetrationMeters <= 0.02) continue;
      const explicitSupportContact = (nextA.supportComponentId === nextB.id || nextB.supportComponentId === nextA.id)
        && Math.min(nextA.position[1] + nextA.size[1], nextB.position[1] + nextB.size[1])
          - Math.max(nextA.position[1], nextB.position[1]) <= 0.03;
      const groundCoverContact = (isGroundCoverComponent(nextA) || isGroundCoverComponent(nextB))
        && Math.abs(nextA.position[1]) <= 0.03 && Math.abs(nextB.position[1]) <= 0.03;
      const assemblyRelation = hasAncestorRelation(originalA, originalB, originalById)
        || originalA.partOfComponentId === originalB.id || originalB.partOfComponentId === originalA.id;
      const reliableSolids = isReliableRigidFitVolume(nextA) && isReliableRigidFitVolume(nextB);
      reports.push({
        firstId: originalA.id,
        secondId: originalB.id,
        classification: explicitSupportContact || assemblyRelation || groundCoverContact ? "allowed" : reliableSolids ? "hard" : "review",
        reason: explicitSupportContact ? "explicit-support-contact" : assemblyRelation ? "related-component-overlap" : groundCoverContact ? "ground-cover-floor-contact" : reliableSolids ? "rendered-rigid-prism-penetration" : "uncertain-proxy-prism-overlap-requires-review",
        penetrationMeters,
      });
    }
  }
  return reports;
}

function characterCollisionComponents(characters: readonly LayoutDraftCharacter[], components: readonly LayoutDraftComponent[]) {
  const componentById = new Map(components.map((component) => [component.id, component]));
  return characters.filter((character) => character.visible).map((character): LayoutDraftComponent => {
    const support = character.supportComponentId ? componentById.get(character.supportComponentId) : undefined;
    const kneeling = character.posture === "kneel";
    const width = character.height * (kneeling ? 0.7 : 0.45);
    const depth = character.height * (kneeling ? 0.65 : 0.3);
    return {
      id: `character:${character.id}`,
      name: character.name,
      category: "prop",
      primitive: "box",
      position: support
        ? [support.position[0], character.position[1], support.position[2]]
        : [...character.position],
      size: [width, character.height * (kneeling ? 0.65 : 1), depth],
      rotationYDegrees: character.rotationYDegrees,
      confidence: character.confidence,
      uncertain: character.uncertain,
      visible: character.visible,
      ...(character.supportComponentId ? { supportComponentId: character.supportComponentId } : {}),
    };
  });
}

function projectedGroundPoint(point: readonly [number, number], camera: FitCamera, aspect: number): [number, number, number] | undefined {
  const focalLengthY = 0.5 / Math.tan(camera.fov * Math.PI / 360);
  return projectImagePointToGround(point, {
    camera: { ...camera, projection: "perspective", source: "estimated", confidence: 0.2, imageAspectRatio: aspect },
    confidence: 0.2, status: "partial", evidenceAxes: [], focalLengthY, cameraHeightMeters: camera.position[1],
  }, aspect);
}

function initializeObservedFootprints(pairs: readonly CameraFitPair[], camera: FitCamera, aspect: number): { components: LayoutDraftComponent[]; failedEvidenceIds: string[] } {
  const failedEvidenceIds: string[] = [];
  const components = pairs.map((pair) => {
    const component = pair.component;
    const footprints = (pair.groundFootprints ?? []).filter((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55);
    if (!pair.onGround) return component;
    const yaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    if (!footprints.length) {
      const centerContact = (pair.groundContacts ?? []).filter((contact) => contact.kind === "center" && contact.visibility === "visible" && contact.confidence >= 0.55)
        .sort((left, right) => right.confidence - left.confidence)[0];
      if (centerContact) {
        const projectedCenter = projectedGroundPoint(centerContact.point, camera, aspect);
        const safetyLimit = Math.max(ROOM_WIDTH_METERS, ROOM_DEPTH_METERS, camera.position[1] * 16);
        if (!projectedCenter || !projectedCenter.every(Number.isFinite)
          || Math.abs(projectedCenter[0]) > safetyLimit || Math.abs(projectedCenter[2]) > safetyLimit) {
          failedEvidenceIds.push(component.id);
          return component;
        }
        return { ...component, position: [projectedCenter[0], component.position[1], projectedCenter[2]] as [number, number, number] };
      }
      // Keep bbox-only floor items in the same candidate-camera coordinate frame
      // as footprint items. A bbox bottom-center is only a low-confidence front
      // contact edge, never a measured center or a new semantic anchor.
      const frontEdge = projectedGroundPoint([(pair.bbox[0] + pair.bbox[2]) / 2, pair.bbox[3]], camera, aspect);
      if (!frontEdge) return component;
      const horizontalForward: [number, number] = [camera.target[0] - camera.position[0], camera.target[2] - camera.position[2]];
      const forwardLength = Math.hypot(...horizontalForward);
      if (!(forwardLength > 1e-4)) return component;
      const forwardX = horizontalForward[0] / forwardLength, forwardZ = horizontalForward[1] / forwardLength;
      const yawDegrees = getLayoutComponentRotationYDegrees(component);
      const halfExtentAlongView = Math.abs(forwardX) * worldXHalfExtent(component.size, yawDegrees)
        + Math.abs(forwardZ) * worldZHalfExtent(component.size, yawDegrees);
      const position: [number, number, number] = [frontEdge[0] + forwardX * halfExtentAlongView, component.position[1], frontEdge[2] + forwardZ * halfExtentAlongView];
      if (![position[0], position[2]].every(Number.isFinite)
        || Math.abs(position[0]) > Math.max(ROOM_WIDTH_METERS, camera.position[1] * 16)
        || Math.abs(position[2]) > Math.max(ROOM_DEPTH_METERS, camera.position[1] * 16)) return component;
      return { ...component, position, uncertain: true,
        notes: [component.notes, "无地面轮廓时以bbox底边中点作为低置信前缘候选，并用同一相机坐标初始化中心；非实测接地点，位置待确认。"].filter(Boolean).join(" ").slice(0, 240) };
    }
    const projectLoop = (loop: readonly [number, number][]) => loop.map((point) => projectedGroundPoint(point, camera, aspect))
      .filter((point): point is [number, number, number] => Boolean(point))
      .map(([x, , z]) => [Math.cos(yaw) * x - Math.sin(yaw) * z, Math.sin(yaw) * x + Math.cos(yaw) * z] as [number, number]);
    const projected = footprints.map((footprint) => ({
      outer: projectLoop(footprint.outer),
      holes: (footprint.holes ?? []).map(projectLoop),
      confidence: footprint.confidence,
    }));
    if (projected.some((part, index) => part.outer.length !== footprints[index].outer.length || part.outer.length < 3
      || part.holes.some((hole, holeIndex) => hole.length !== (footprints[index].holes?.[holeIndex]?.length ?? 0)))) {
      failedEvidenceIds.push(component.id);
      return component;
    }
    const allOuter = projected.flatMap((part) => part.outer);
    const minX = Math.min(...allOuter.map(([x]) => x)), maxX = Math.max(...allOuter.map(([x]) => x));
    const minZ = Math.min(...allOuter.map(([, z]) => z)), maxZ = Math.max(...allOuter.map(([, z]) => z));
    const width = maxX - minX, depth = maxZ - minZ;
    const safetyLimit = Math.max(ROOM_WIDTH_METERS, ROOM_DEPTH_METERS, camera.position[1] * 16);
    if (!(width > 0.02 && depth > 0.02 && width <= safetyLimit && depth <= safetyLimit)
      || allOuter.some(([x, z]) => Math.abs(x) > safetyLimit || Math.abs(z) > safetyLimit)) {
      failedEvidenceIds.push(component.id);
      return component;
    }
    const localCenterX = (minX + maxX) / 2, localCenterZ = (minZ + maxZ) / 2;
    const position: [number, number, number] = [
      Math.cos(yaw) * localCenterX + Math.sin(yaw) * localCenterZ,
      component.position[1],
      -Math.sin(yaw) * localCenterX + Math.cos(yaw) * localCenterZ,
    ];
    const normalized = projected.map((part) => ({
      outer: part.outer.map(([x, z]) => [((x - localCenterX) / width) + 0.5, ((z - localCenterZ) / depth) + 0.5] as [number, number]),
      ...(part.holes.length ? { holes: part.holes.map((hole) => hole.map(([x, z]) => [((x - localCenterX) / width) + 0.5, ((z - localCenterZ) / depth) + 0.5] as [number, number])) } : {}),
      confidence: part.confidence,
    }));
    if (!normalized.every((part) => [...part.outer, ...(part.holes ?? []).flat()].every(([x, z]) => x >= -1e-6 && x <= 1 + 1e-6 && z >= -1e-6 && z <= 1 + 1e-6))) {
      failedEvidenceIds.push(component.id);
      return component;
    }
    const heightScore = (candidateHeight: number) => {
      const candidateComponent = { ...component, position, size: [width, candidateHeight, depth] as [number, number, number] };
      const predicted = cameraFitBreakdown([{ ...pair, component: candidateComponent }], camera, aspect).pairs[0];
      if (!predicted) return Infinity;
      const prior = 0.02 * Math.abs(Math.log(candidateHeight / Math.max(0.1, component.size[1])));
      return predicted.weightedContribution + prior;
    };
    let height = component.size[1];
    // A floor cover's pixel height mostly reflects perspective across its depth;
    // keep its semantic thinness prior instead of fitting that projection as thickness.
    if (!isFlatDecorationSemantic(`${component.semanticType ?? ""} ${component.name}`)) {
      const heightCandidates = [0.35, 0.55, 0.75, 1, 1.35, 1.75, 2.25, 2.9, 3.6];
      height = heightCandidates.reduce((best, candidateHeight) => {
        const score = heightScore(candidateHeight);
        return score < best.score ? { height: candidateHeight, score } : best;
      }, { height, score: heightScore(height) }).height;
      let low = Math.max(0.25, height / 1.5), high = Math.min(Math.max(3.6, camera.position[1] * 2), Math.max(height * 1.5, height + 1));
      for (let round = 0; round < 8; round += 1) {
        const left = low + (high - low) / 3, right = high - (high - low) / 3;
        if (heightScore(left) <= heightScore(right)) high = right; else low = left;
      }
      const continuous = (low + high) / 2;
      if (heightScore(continuous) < heightScore(height)) height = continuous;
    }
    return { ...component, position, size: [width, height, depth] as [number, number, number], groundFootprint: normalized, uncertain: true,
      notes: [component.notes, "无可解析消失点；按保守候选相机反投影可见地面轮廓，位置、宽深和轮廓均需复核。"].filter(Boolean).join(" ").slice(0, 240) };
  });
  return { components, failedEvidenceIds };
}

function projectVisibleFloorBounds(bbox: readonly [number, number, number, number], camera: FitCamera, aspect: number) {
  const corners: [number, number][] = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]];
  const points = corners.map((point) => projectedGroundPoint(point, camera, aspect)).filter((point): point is [number, number, number] => Boolean(point));
  if (points.length < 2) return undefined;
  const minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
  const minZ = Math.min(...points.map(([, , z]) => z)), maxZ = Math.max(...points.map(([, , z]) => z));
  const width = maxX - minX, depth = maxZ - minZ;
  const safetyLimit = Math.max(ROOM_WIDTH_METERS, ROOM_DEPTH_METERS, camera.position[1] * 16);
  if (!(width > 0.02 && depth > 0.02 && width <= safetyLimit && depth <= safetyLimit)
    || points.some(([x, , z]) => Math.abs(x) > safetyLimit || Math.abs(z) > safetyLimit)) return undefined;
  return { position: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2] as [number, number, number], size: [width, 0.02, depth] as [number, number, number] };
}

function sceneEvidenceError(pairs: readonly CameraFitPair[], camera: FitCamera, aspect: number, components: readonly LayoutDraftComponent[], sceneScale: number) {
  const byId = new Map(components.map((component) => [component.id, component]));
  const forward = [camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]];
  const forwardLength = Math.hypot(...forward) || 1;
  const unitForward = forward.map((value) => value / forwardLength);
  let error = 0;
  const evidenceAxes = pairs.find((pair) => pair.geometryEvidence)?.geometryEvidence?.axes ?? [];
  const right = [-unitForward[2], 0, unitForward[0]];
  const rightLength = Math.hypot(right[0], right[2]) || 1;
  right[0] /= rightLength; right[2] /= rightLength;
  const up = [right[1] * unitForward[2] - right[2] * unitForward[1], right[2] * unitForward[0] - right[0] * unitForward[2], right[0] * unitForward[1] - right[1] * unitForward[0]];
  const axisWorld: Record<"lateral" | "depth" | "vertical", number[]> = { lateral: [1, 0, 0], depth: [0, 0, 1], vertical: [0, 1, 0] };
  for (const evidence of evidenceAxes) {
    const direction = axisWorld[evidence.axis];
    const cameraX = direction[0] * right[0] + direction[1] * right[1] + direction[2] * right[2];
    const cameraY = direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2];
    const cameraZ = direction[0] * unitForward[0] + direction[1] * unitForward[1] + direction[2] * unitForward[2];
    const focal = 0.5 / Math.tan(camera.fov * Math.PI / 360);
    // A line axis is unoriented: either sign points to the same vanishing
    // point. Negative camera-space depth must remain a finite VP as well.
    const predicted = Math.abs(cameraZ) > 1e-4
      ? [0.5 + cameraX / cameraZ * focal / aspect, 0.5 - cameraY / cameraZ * focal]
      : undefined;
    for (const segment of evidence.segments) {
      const observed = [segment.end[0] - segment.start[0], -(segment.end[1] - segment.start[1])];
      const observedLength = Math.hypot(...observed) || 1;
      let agreement = 0;
      if (predicted) {
        const midpoint = [(segment.start[0] + segment.end[0]) / 2, (segment.start[1] + segment.end[1]) / 2];
        const toVanishing = [predicted[0] - midpoint[0], -(predicted[1] - midpoint[1])];
        const length = Math.hypot(...toVanishing) || 1;
        agreement = Math.abs((observed[0] * toVanishing[0] + observed[1] * toVanishing[1]) / (observedLength * length));
      } else {
        const predictedDirection = [cameraX, -cameraY];
        const length = Math.hypot(...predictedDirection) || 1;
        agreement = Math.abs((observed[0] * predictedDirection[0] + observed[1] * predictedDirection[1]) / (observedLength * length));
      }
      error += segment.confidence * 0.08 * (1 - agreement);
    }
  }
  for (const pair of pairs) {
    const component = byId.get(pair.component.id) ?? pair.component;
    const weight = Math.max(0.15, pair.confidence) * Math.max(0.15, pair.component.confidence);
    for (const footprint of pair.groundFootprints ?? []) {
      if (footprint.confidence < 0.45 || footprint.visibility !== "visible") continue;
      const projected = footprint.outer.flatMap((point) => {
        const world = projectedGroundPoint(point, camera, aspect);
        return world ? [world] : [];
      });
      if (projected.length !== footprint.outer.length || projected.length < 3) continue;
      const minX = Math.min(...projected.map(([x]) => x)), maxX = Math.max(...projected.map(([x]) => x));
      const minZ = Math.min(...projected.map(([, , z]) => z)), maxZ = Math.max(...projected.map(([, , z]) => z));
      const yaw = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
      const predictedX = Math.abs(Math.cos(yaw)) * component.size[0] + Math.abs(Math.sin(yaw)) * component.size[2];
      const predictedZ = Math.abs(Math.sin(yaw)) * component.size[0] + Math.abs(Math.cos(yaw)) * component.size[2];
      const centerError = Math.hypot((minX + maxX) / 2 - component.position[0], (minZ + maxZ) / 2 - component.position[2]) / Math.max(0.5, sceneScale);
      const scaleError = Math.abs(Math.log(Math.max(1e-3, maxX - minX) / Math.max(1e-3, predictedX)))
        + Math.abs(Math.log(Math.max(1e-3, maxZ - minZ) / Math.max(1e-3, predictedZ)));
      error += weight * footprint.confidence * (0.85 * Math.min(2, centerError) + 0.18 * Math.min(3, scaleError));
    }
    for (const contact of pair.groundContacts ?? []) {
      if (contact.kind !== "center" || contact.visibility !== "visible" || contact.confidence < 0.55) continue;
      const world = projectedGroundPoint(contact.point, camera, aspect);
      if (world) error += weight * contact.confidence * 1.1 * Math.min(2, Math.hypot(world[0] - component.position[0], world[2] - component.position[2]) / Math.max(0.5, sceneScale));
    }
    for (const occludedId of pair.occludesIds ?? []) {
      const target = byId.get(occludedId);
      if (!target || target.id === component.id) continue;
      const depth = (point: readonly number[]) => (point[0] - camera.position[0]) * unitForward[0]
        + (point[1] - camera.position[1]) * unitForward[1] + (point[2] - camera.position[2]) * unitForward[2];
      const sourceDepth = depth([component.position[0], component.position[1] + component.size[1] / 2, component.position[2]]);
      const targetDepth = depth([target.position[0], target.position[1] + target.size[1] / 2, target.position[2]]);
      if (sourceDepth > targetDepth + 0.05) error += weight * 0.2 * Math.min(2, (sourceDepth - targetDepth) / Math.max(0.5, sceneScale));
    }
  }
  return error;
}

function refineJointSceneCandidate(
  pairs: readonly CameraFitPair[],
  camera: FitCamera,
  aspect: number,
  allComponents: readonly LayoutDraftComponent[],
  characters: readonly LayoutDraftCharacter[],
  initialCollisions: readonly FitCollisionPair[],
  sceneScale: number,
  options: { preserveFootprintTopology?: boolean } = {},
) {
  let fitted = pairs.map(({ component }) => ({ ...component, position: [...component.position] as [number, number, number], size: [...component.size] as [number, number, number] }));
  const initialScene = [...allComponents, ...characterCollisionComponents(characters, allComponents)];
  type PositionEvidence = "visible-footprint-fixed" | "visible-center-contact-fixed" | "visible-center-contact-bounded" | "observed-bbox-center-bounded" | "low-confidence-bbox-center-bounded";
  const positionEvidence = pairs.map((pair) => {
    const hasUsableFootprint = pair.groundFootprints?.some((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55) ?? false;
    const visibleCenterConfidence = Math.max(0, ...(pair.groundContacts ?? [])
      .filter((contact) => contact.kind === "center" && contact.visibility === "visible")
      .map((contact) => contact.confidence));
    const fixedByCenter = !hasUsableFootprint && visibleCenterConfidence >= 0.85;
    const basis: PositionEvidence = hasUsableFootprint
      ? "visible-footprint-fixed"
      : fixedByCenter
        ? "visible-center-contact-fixed"
        : visibleCenterConfidence >= 0.55
          ? "visible-center-contact-bounded"
          : pair.confidence >= 0.55
            ? "observed-bbox-center-bounded"
            : "low-confidence-bbox-center-bounded";
    let positionLimitMeters = options.preserveFootprintTopology ? Math.min(0.5, sceneScale * 0.1) : sceneScale * 2.5;
    if (!hasUsableFootprint && visibleCenterConfidence >= 0.55 && visibleCenterConfidence < 0.85) {
      positionLimitMeters *= Math.max(0.25, 1 - (visibleCenterConfidence - 0.55) * 0.8);
    }
    const fixed = hasUsableFootprint || fixedByCenter;
    return {
      id: pair.component.id,
      basis,
      fixed,
      maxDeltaMeters: fixed ? 0 : positionLimitMeters,
      visibleCenterConfidence,
      positionLimitMeters,
      hasUsableFootprint,
    };
  });
  const evaluate = (candidate: LayoutDraftComponent[]) => {
    const nextPairs = pairs.map((pair, index) => ({ ...pair, component: candidate[index] }));
    if (!observedHorizontalOrderIsPreserved(pairs, candidate, camera)) return undefined;
    const projectionError = cameraFitError(nextPairs, camera, aspect);
    const carried = carryFittedParentMotion(candidate, allComponents);
    const characterFitted = characterCollisionComponents(characters, carried.components);
    const collisions = fitCollisionPairs(initialScene, [...carried.components, ...characterFitted]);
    if (introducesMajorOverlap(collisions, initialScene, initialCollisions)) return undefined;
    const geometryError = sceneEvidenceError(pairs, camera, aspect, carried.components, sceneScale);
    const carriedById = new Map(carried.components.map((component) => [component.id, component]));
    const initialById = new Map(initialScene.map((component) => [component.id, component]));
    const supportError = carried.components.reduce((sum, component) => {
      if (!component.supportComponentId) return sum;
      const support = carriedById.get(component.supportComponentId) ?? initialById.get(component.supportComponentId);
      if (!support) return sum;
      const verticalGap = Math.abs(component.position[1] - getLayoutSupportTopY(support, 0, component.position));
      return sum + Math.max(0.15, component.confidence) * Math.min(2, verticalGap / Math.max(0.5, sceneScale)) * 0.22;
    }, 0);
    const collisionPenalty = collisions.filter((pair) => pair.classification !== "allowed").reduce((sum, pair) => {
      const left = carriedById.get(pair.firstId) ?? initialById.get(pair.firstId);
      const right = carriedById.get(pair.secondId) ?? initialById.get(pair.secondId);
      return sum + (left && right ? Math.min(1, fitPairPenetration(left, right) / Math.max(0.5, sceneScale)) * 0.22 : 0);
    }, 0);
    const rawError = projectionError + geometryError + supportError + collisionPenalty;
    const movedMeters = candidate.reduce((sum, component, index) => sum + Math.hypot(
      component.position[0] - pairs[index].component.position[0],
      component.position[1] - pairs[index].component.position[1],
      component.position[2] - pairs[index].component.position[2],
    ), 0);
    const scalePrior = candidate.reduce((sum, component, index) => sum + [0, 1, 2].reduce((total, axis) => total + Math.abs(Math.log(component.size[axis] / pairs[index].component.size[axis])), 0), 0);
    const evidenceWeight = candidate.reduce((sum, component) => sum + Math.max(0.45, component.confidence), 0) || 1;
    return { rawError, score: rawError + 0.035 * movedMeters / sceneScale + 0.055 * scalePrior / evidenceWeight, movement: movedMeters / candidate.length, carried, collisions };
  };
  let best = evaluate(fitted);
  const freePositionAxes = pairs.map((pair, index) => {
    const evidence = positionEvidence[index];
    return !pair.onGround || evidence.fixed || (!isMajorFitObject(pair.component) && !evidence.hasUsableFootprint) ? [] : [0, 2] as const;
  });
  const freeSizeAxes = pairs.map((pair, index) => {
    const hasUsableFootprint = positionEvidence[index].hasUsableFootprint;
    if (!pair.onGround || (!isMajorFitObject(pair.component) && !hasUsableFootprint)) return [] as number[];
    // A reliable observed footprint fixes the horizontal dimensions in every
    // refinement branch. Camera-specific footprint projection is handled by
    // candidate initialization; local refinement may only change height.
    return hasUsableFootprint ? [1] : [0, 1, 2];
  });
  const movableCoordinateCount = freePositionAxes.reduce((sum, axes) => sum + axes.length, 0)
    + freeSizeAxes.reduce((sum, axes) => sum + axes.length, 0);
  const evaluationBudget = Math.min(540, Math.max(180, movableCoordinateCount * 12));
  let evaluationCount = 1;
  let feasibleEvaluationCount = best ? 1 : 0;
  let acceptedMoves = 0;
  let completedScaleLevels = 0;
  let budgetExhausted = false;
  if (!best) return {
    fitted, score: Infinity, rawError: Infinity, initialScore: Infinity, movement: 0,
    carried: carryFittedParentMotion([], allComponents), collisions: [...initialCollisions], constraintHits: [],
    search: { evaluationBudget, evaluationCount, feasibleEvaluationCount, acceptedMoves, completedScaleLevels, budgetExhausted, positionEvidence: positionEvidence.map(({ id, basis, fixed, maxDeltaMeters }) => ({ id, basis, fixed, maxDeltaMeters })) },
  };
  const initialScore = best.score;
  const basePositionStep = options.preserveFootprintTopology ? Math.min(0.24, sceneScale * 0.06) : Math.min(0.48, sceneScale * 0.12);
  const stepLevels = [
    { position: basePositionStep, size: 0.32 },
    { position: basePositionStep / 2, size: 0.16 },
    { position: basePositionStep / 4, size: 0.08 },
  ];
  const tryCoordinate = (index: number, kind: "position" | "size", axis: number, step: number) => {
    const pair = pairs[index];
    const original = pair.component;
    const candidates: Array<{ components: LayoutDraftComponent[]; score: number; result: NonNullable<ReturnType<typeof evaluate>> }> = [];
    for (const sign of [-1, 1] as const) {
      const current = fitted[index];
      let nextComponent: LayoutDraftComponent;
      if (kind === "position") {
        const evidence = positionEvidence[index];
        const position = [...current.position] as [number, number, number];
        const minimum = original.position[axis] - evidence.positionLimitMeters;
        const maximum = original.position[axis] + evidence.positionLimitMeters;
        const proposed = clamp(position[axis] + sign * step, minimum, maximum);
        if (Math.abs(proposed - position[axis]) < 1e-6) continue;
        position[axis] = proposed;
        nextComponent = { ...current, position };
      } else {
        const size = [...current.size] as [number, number, number];
        const minimumScale = options.preserveFootprintTopology ? 0.45 : 0.25;
        const maximumScale = options.preserveFootprintTopology ? 1.75 : 4;
        const minimum = Math.max(0.05, original.size[axis] * minimumScale);
        const maximum = Math.min(sceneScale * 2, original.size[axis] * maximumScale);
        const factor = sign < 0 ? 1 / (1 + step) : 1 + step;
        const proposed = clamp(size[axis] * factor, minimum, maximum);
        if (Math.abs(proposed - size[axis]) < 1e-6) continue;
        size[axis] = proposed;
        nextComponent = { ...current, size };
      }
      if (evaluationCount >= evaluationBudget) { budgetExhausted = true; return; }
      const next = [...fitted];
      next[index] = nextComponent;
      evaluationCount += 1;
      const result = evaluate(next);
      if (result) {
        feasibleEvaluationCount += 1;
        if (best && result.score + 1e-6 < best.score) candidates.push({ components: next, score: result.score, result });
      }
    }
    const selected = candidates.reduce<typeof candidates[number] | undefined>((winner, candidate) => !winner || candidate.score < winner.score ? candidate : winner, undefined);
    if (!selected) return false;
    fitted = selected.components;
    best = selected.result;
    acceptedMoves += 1;
    return true;
  };
  for (const steps of stepLevels) {
    for (let sweep = 0; sweep < 2; sweep += 1) {
      let sweepImproved = false;
      for (let index = 0; index < fitted.length && evaluationCount < evaluationBudget; index += 1) {
        for (const axis of freePositionAxes[index]) {
          if (tryCoordinate(index, "position", axis, steps.position)) sweepImproved = true;
          if (evaluationCount >= evaluationBudget) break;
        }
        if (evaluationCount >= evaluationBudget) break;
        for (const axis of freeSizeAxes[index]) {
          if (tryCoordinate(index, "size", axis, steps.size)) sweepImproved = true;
          if (evaluationCount >= evaluationBudget) break;
        }
      }
      if (!sweepImproved) break;
    }
    completedScaleLevels += 1;
    if (evaluationCount >= evaluationBudget) { budgetExhausted = true; break; }
    // Progressively smaller steps are introduced after this bounded level.
  }
  type ConstraintHit = { id: string; kind: "size" | "position"; axis: number; boundary: "minimum" | "maximum" | "limit"; ratio?: number; value?: number };
  const constraintHits: ConstraintHit[] = [];
  pairs.forEach((pair, index) => {
    const original = pair.component, result = fitted[index];
    const hasFootprint = pair.groundFootprints?.some((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55);
    const sizeAxes = hasFootprint ? [1] as const : [0, 1, 2] as const;
    const minimumScale = options.preserveFootprintTopology ? 0.45 : 0.25;
    const maximumScale = options.preserveFootprintTopology ? 1.75 : 4;
    for (const axis of sizeAxes) {
      const ratio = result.size[axis] / original.size[axis];
      if (ratio <= minimumScale + 1e-3) constraintHits.push({ id: original.id, kind: "size", axis, boundary: "minimum", ratio });
      else if (ratio >= maximumScale - 1e-3) constraintHits.push({ id: original.id, kind: "size", axis, boundary: "maximum", ratio });
    }
    const positionEvidenceForPair = positionEvidence[index];
    if (!positionEvidenceForPair.fixed && pair.onGround && (isMajorFitObject(original) || hasFootprint)) for (const axis of [0, 2] as const) {
      const delta = result.position[axis] - original.position[axis];
      const limit = positionEvidenceForPair.positionLimitMeters;
      if (delta <= -limit + 1e-3) constraintHits.push({ id: original.id, kind: "position", axis, boundary: "minimum", value: delta });
      else if (delta >= limit - 1e-3) constraintHits.push({ id: original.id, kind: "position", axis, boundary: "maximum", value: delta });
    }
  });
  return {
    fitted, ...best, initialScore, constraintHits,
    search: {
      evaluationBudget, evaluationCount, feasibleEvaluationCount, acceptedMoves, completedScaleLevels, budgetExhausted,
      positionEvidence: positionEvidence.map(({ id, basis, fixed, maxDeltaMeters }) => ({ id, basis, fixed, maxDeltaMeters })),
    },
  };
}

/** Fits only the camera against observed object bounds. Scene geometry and explicit
 * support/partOf relationships remain fixed; a high residual stays under review. */
export function fitReferenceScene(pairs: readonly CameraFitPair[], fallback: LayoutDraft["referenceCamera"], aspect: number, allComponents: readonly LayoutDraftComponent[], characters: readonly LayoutDraftCharacter[] = []) {
  const initialComponents = [...allComponents, ...characterCollisionComponents(characters, allComponents)];
  const initialCollisionPairs = fitCollisionPairs(initialComponents, initialComponents);
  const initialCollisionCounts = summarizeFitCollisions(initialCollisionPairs);
  const initialPenetrationMeters = summarizeFitPenetration(initialCollisionPairs);
  const initialRoomBoundaryViolations = getRoomBoundaryViolations(allComponents);
  const initialPhysicalValidity = {
    withinRoom: initialRoomBoundaryViolations.length === 0,
    roomBoundsEvaluated: allComponents.some((component) => component.category === "ground"),
    cameraOutsideGeometry: fallback ? !cameraInsideGeometry(fallback.position, allComponents) : false,
    cameraGeometryEvaluated: Boolean(fallback),
    hardCollisionCount: initialCollisionCounts.hard,
    initialPenetrationMeters,
    finalPenetrationMeters: initialPenetrationMeters,
    initialCollisionCounts,
    finalCollisionCounts: initialCollisionCounts,
    roomBoundaryViolations: initialRoomBoundaryViolations,
  };
  if (pairs.length < 3 || !fallback) return { camera: fallback, before: undefined, best: undefined, bestCandidate: undefined, cameraOnlyBest: undefined, count: pairs.length, candidateCount: 0, rejectionReason: "insufficient-evidence" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: 0, collisionPairs: initialCollisionPairs, physicalValidity: initialPhysicalValidity, passedErrorThreshold: undefined };
  const floor = allComponents.find((component) => component.category === "ground");
  const before = cameraFitError(pairs, fallback, aspect);
  type RefinementSearch = ReturnType<typeof refineJointSceneCandidate>["search"] | undefined;
  let best: { camera: FitCamera; error: number; rawError: number; components: LayoutDraftComponent[]; movement: number; refinementConstraintHits?: Array<{ id: string; kind: "size" | "position"; axis: number; boundary: "minimum" | "maximum" | "limit"; ratio?: number; value?: number }>; refinementSearch?: RefinementSearch } | undefined;
  let bestCameraOnly: { camera: FitCamera; rawError: number } | undefined;
  const sceneCorners = pairs.flatMap(({ component }) => cameraWorldCorners(component));
  const sceneScale = Math.max(1, ...[0, 1, 2].map((axis) => Math.max(...sceneCorners.map((point) => point[axis])) - Math.min(...sceneCorners.map((point) => point[axis]))));
  const initialReviewPenalty = initialCollisionPairs.filter((pair) => pair.classification !== "allowed").reduce((sum, pair) => sum + 0.12 * pair.penetrationMeters / sceneScale, 0);
  const objective = (camera: FitCamera, candidatePairs = pairs, components = allComponents) => cameraFitError(candidatePairs, camera, aspect)
    + sceneEvidenceError(candidatePairs, camera, aspect, components, sceneScale)
    + initialReviewPenalty;
  const beforeObjective = objective(fallback);
  const generatedCandidates = cameraCandidates(pairs, allComponents, aspect, fallback);
  const explicitCameras: FitCamera[] = [
    ...(fallback ? [{ position: [...fallback.position] as [number, number, number], target: [...fallback.target] as [number, number, number], fov: fallback.fov }] : []),
    ...pairs.flatMap(({ groundCamera }) => groundCamera ? [{ position: [...groundCamera.position] as [number, number, number], target: [...groundCamera.target] as [number, number, number], fov: groundCamera.fov }] : []),
  ];
  const candidateKey = (camera: FitCamera) => [...camera.position, ...camera.target, camera.fov].map((value) => value.toFixed(4)).join(":");
  const uniqueCandidates = [...new Map([...explicitCameras, ...generatedCandidates].map((camera) => [candidateKey(camera), camera])).values()]
    .filter((camera) => camera.position[2] > camera.target[2] && !cameraInsideGeometry(camera.position, allComponents));
  const hasParsedGroundCamera = pairs.some((pair) => pair.groundCamera);
  const usableFootprintPairIndices = pairs.flatMap((pair, index) => pair.onGround && pair.groundFootprints?.some((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55) ? [index] : []);
  const useFootprintCameraCandidates = !hasParsedGroundCamera && usableFootprintPairIndices.length > 0;
  const characterOriginal = characterCollisionComponents(characters, allComponents);
  const originalScene = [...allComponents, ...characterOriginal];
  const initialCollisions = fitCollisionPairs(originalScene, originalScene);
  const initialCollisionKeys = new Set(initialCollisions.map((collision) => [collision.firstId, collision.secondId].sort().join("\u0000")));
  const failedFootprintInitialization = new Map<string, number>();
  const majorOverlapRejects = new Map<string, { firstId: string; secondId: string; candidateCount: number; maxPenetrationMeters: number }>();
  let initializedFootprintCandidateCount = 0;
  let preselectionSafeCandidateCount = 0;
  let footprintOverlapRejectedCandidateCount = 0;
  let safetyCheckedFootprintCandidateCount = 0;
  const recordMajorOverlapRejects = (collisions: readonly FitCollisionPair[], carriedComponents: readonly LayoutDraftComponent[]) => {
    for (const collision of collisions) {
      if (collision.classification === "allowed" || initialCollisionKeys.has([collision.firstId, collision.secondId].sort().join("\u0000"))) continue;
      const first = originalScene.find((component) => component.id === collision.firstId);
      const second = originalScene.find((component) => component.id === collision.secondId);
      if (!first || !second || !isMajorFitObject(first) || !isMajorFitObject(second)) continue;
      const key = [collision.firstId, collision.secondId].sort().join("\u0000");
      const previous = majorOverlapRejects.get(key);
      majorOverlapRejects.set(key, {
        firstId: collision.firstId,
        secondId: collision.secondId,
        candidateCount: (previous?.candidateCount ?? 0) + 1,
        maxPenetrationMeters: Math.max(previous?.maxPenetrationMeters ?? 0, fitPairPenetration(
          carriedComponents.find((component) => component.id === collision.firstId) ?? first,
          carriedComponents.find((component) => component.id === collision.secondId) ?? second,
        )),
      });
    }
  };
  const protectedKeys = new Set(explicitCameras.map(candidateKey));
  const targetSafeFootprintCandidateCount = 12;
  let safetyCheckStoppedEarly = false;
  let axisConsistentCandidateIncluded = false;
  let axisConsistentCandidateError: number | null = null;
  let safePoseDiverseCandidateCount = 0;
  const rankedCandidates = useFootprintCameraCandidates
    ? (() => {
      const scored = uniqueCandidates.flatMap((camera) => {
      const initialization = initializeObservedFootprints(pairs, camera, aspect);
      const initialized = initialization.components;
      const validFootprints = usableFootprintPairIndices.filter((index) => Boolean(initialized[index].groundFootprint)).length;
      if (validFootprints !== usableFootprintPairIndices.length || initialization.failedEvidenceIds.length > 0) {
        for (const id of initialization.failedEvidenceIds) failedFootprintInitialization.set(id, (failedFootprintInitialization.get(id) ?? 0) + 1);
        for (const index of usableFootprintPairIndices) {
          if (!initialized[index].groundFootprint) {
            const id = pairs[index].component.id;
            failedFootprintInitialization.set(id, (failedFootprintInitialization.get(id) ?? 0) + 1);
          }
        }
        return [];
      }
      initializedFootprintCandidateCount += 1;
      const nextPairs = pairs.map((pair, index) => ({ ...pair, component: initialized[index] }));
      const carried = carryFittedParentMotion(initialized, allComponents);
      const dimensionPrior = usableFootprintPairIndices.reduce((sum, index) => {
        const original = pairs[index].component, fitted = initialized[index];
        const originalRatio = original.size[0] / original.size[2], fittedRatio = fitted.size[0] / fitted.size[2];
        return sum + Math.abs(Math.log(fitted.size[0] / original.size[0])) + Math.abs(Math.log(fitted.size[1] / original.size[1]))
          + Math.abs(Math.log(fitted.size[2] / original.size[2])) + Math.abs(Math.log(fittedRatio / originalRatio));
      }, 0) / usableFootprintPairIndices.length;
      const error = cameraFitError(nextPairs, camera, aspect) + sceneEvidenceError(nextPairs, camera, aspect, carried.components, sceneScale) + 0.045 * dimensionPrior;
      return [{ camera, error, axisError: cameraAxisDirectionError(pairs, camera, aspect), initialized, carried: carried.components }];
      }).sort((a, b) => a.error - b.error);
      const axisSeedKeys = scored.filter((candidate) => candidate.axisError !== null)
        .sort((a, b) => a.axisError! - b.axisError!).slice(0, 3).map((candidate) => candidateKey(candidate.camera));
      const safe: Array<{ camera: FitCamera; error: number; axisError: number | null; initialized: LayoutDraftComponent[] }> = [];
      const protectedRemaining = new Set(scored.filter(({ camera }) => protectedKeys.has(candidateKey(camera)) || axisSeedKeys.includes(candidateKey(camera))).map(({ camera }) => candidateKey(camera)));
      for (const candidate of scored) {
        const key = candidateKey(candidate.camera);
        if (safe.length >= targetSafeFootprintCandidateCount && protectedRemaining.size === 0
          && candidate.error >= [...safe].sort((a, b) => a.error - b.error)[targetSafeFootprintCandidateCount - 1].error) {
          safetyCheckStoppedEarly = true;
          break;
        }
        protectedRemaining.delete(key);
        safetyCheckedFootprintCandidateCount += 1;
        const collisions = fitCollisionPairs(originalScene, [...candidate.carried, ...characterOriginal]);
        if (introducesMajorOverlap(collisions, originalScene, initialCollisions)) {
          footprintOverlapRejectedCandidateCount += 1;
          recordMajorOverlapRejects(collisions, candidate.carried);
          continue;
        }
        preselectionSafeCandidateCount += 1;
        const fittedById = new Map(candidate.carried.map((component) => [component.id, component]));
        const originalById = new Map(allComponents.map((component) => [component.id, component]));
        const collisionPenalty = collisions.reduce((sum, collision) => {
          if (collision.classification === "allowed") return sum;
          const left = fittedById.get(collision.firstId) ?? originalById.get(collision.firstId);
          const right = fittedById.get(collision.secondId) ?? originalById.get(collision.secondId);
          return sum + (left && right ? 0.12 * Math.min(1, fitPairPenetration(left, right) / Math.max(0.5, sceneScale)) : 0);
        }, 0);
        safe.push({ camera: candidate.camera, error: candidate.error + collisionPenalty, axisError: candidate.axisError, initialized: candidate.initialized });
      }
      const sortedSafe = safe.sort((a, b) => a.error - b.error);
      const axisCandidate = sortedSafe.filter((candidate) => candidate.axisError !== null)
        .reduce<typeof sortedSafe[number] | undefined>((best, candidate) => !best || candidate.axisError! < best.axisError! ? candidate : best, undefined);
      axisConsistentCandidateError = axisCandidate?.axisError ?? null;
      if (sortedSafe.length <= targetSafeFootprintCandidateCount) {
        axisConsistentCandidateIncluded = Boolean(axisCandidate);
        safePoseDiverseCandidateCount = sortedSafe.length;
        return sortedSafe;
      }
      const selected = [sortedSafe[0]];
      if (axisCandidate && !selected.some((candidate) => candidateKey(candidate.camera) === candidateKey(axisCandidate.camera))) {
        selected.push(axisCandidate);
        axisConsistentCandidateIncluded = true;
      }
      const angleDifference = (left: number, right: number) => {
        const difference = Math.abs(left - right) % (Math.PI * 2);
        return Math.min(difference, Math.PI * 2 - difference);
      };
      const azimuth = (camera: FitCamera) => Math.atan2(camera.position[0] - camera.target[0], camera.position[2] - camera.target[2]);
      while (selected.length < targetSafeFootprintCandidateCount) {
        const remaining = sortedSafe.filter((candidate) => !selected.some((item) => candidateKey(item.camera) === candidateKey(candidate.camera)));
        if (!remaining.length) break;
        const next = remaining.sort((a, b) => {
          const diversity = (candidate: typeof a) => Math.min(...selected.map((item) => angleDifference(azimuth(candidate.camera), azimuth(item.camera))))
            + Math.min(...selected.map((item) => Math.abs(candidate.camera.fov - item.camera.fov))) * Math.PI / 180;
          return diversity(b) - diversity(a) || a.error - b.error;
        })[0];
        selected.push(next);
      }
      safePoseDiverseCandidateCount = selected.length;
      return selected;
    })()
    : uniqueCandidates.map((camera) => ({ camera, error: objective(camera) })).sort((a, b) => a.error - b.error);
  const candidates = [...rankedCandidates.filter(({ camera }) => protectedKeys.has(candidateKey(camera))).slice(0, useFootprintCameraCandidates ? 1 : 4),
    ...rankedCandidates.filter(({ camera }) => !protectedKeys.has(candidateKey(camera))).slice(0, useFootprintCameraCandidates ? 11 : 12)]
    .slice(0, 16).map(({ camera }) => camera);
  const footprintSeedByCamera = new Map(rankedCandidates.filter((candidate): candidate is typeof candidate & { initialized: LayoutDraftComponent[] } => "initialized" in candidate)
    .map((candidate) => [candidateKey(candidate.camera), candidate.initialized]));
  let jointRefineCandidatesTried = 0;
  let jointRefineCandidatesAccepted = 0;
  let jointRefineBestScoreBefore = Infinity;
  let jointRefineBestScoreAfter = Infinity;
  let selectedBranch: "footprint" | "joint" | "none" = "none";
  const cameraOnlyCandidates = candidates.filter((camera) => observedHorizontalOrderIsPreserved(pairs, pairs.map(({ component }) => component), camera)).map((camera) => ({
    camera,
    rawError: objective(camera),
  }));
  bestCameraOnly = cameraOnlyCandidates.reduce<typeof bestCameraOnly>((current, candidate) => !current || candidate.rawError < current.rawError ? candidate : current, undefined);
  const hasSpatialEvidence = pairs.some((pair) => pair.groundFootprints?.length
    || pair.groundContacts?.some((contact) => contact.kind === "center" && contact.visibility === "visible")
    || pair.occludesIds?.length);
  const failedJointInitialization = new Map<string, number>();
  if (!hasSpatialEvidence && !bestCameraOnly) return {
    camera: fallback, before, best: undefined, bestCandidate: undefined, cameraOnlyBest: undefined,
    count: pairs.length, candidateCount: candidates.length, rejectionReason: "no-safe-candidate" as const,
    qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0,
    movedComponentCount: 0, movement: 0, collisionPairs: initialCollisions,
    physicalValidity: initialPhysicalValidity, passedErrorThreshold: undefined,
  };
  if (useFootprintCameraCandidates) {
    let safeRefinementSeeds = 0;
    for (const camera of candidates) {
      const initialized = footprintSeedByCamera.get(candidateKey(camera));
      if (!initialized) continue;
      const nextPairs = pairs.map((pair, index) => ({ ...pair, component: initialized[index] }));
      const carried = carryFittedParentMotion(initialized, allComponents);
      let fitted = initialized;
      let evaluatedPairs = nextPairs;
      let candidateCarried = carried;
      let refinementConstraintHits: Array<{ id: string; kind: "size" | "position"; axis: number; boundary: "minimum" | "maximum" | "limit"; ratio?: number; value?: number }> = [];
      let refinementSearch: RefinementSearch = undefined;
      const collisions = fitCollisionPairs(originalScene, [...carried.components, ...characterOriginal]);
      if (introducesMajorOverlap(collisions, originalScene, initialCollisions)) {
        footprintOverlapRejectedCandidateCount += 1;
        recordMajorOverlapRejects(collisions, carried.components);
        continue;
      }
      if (safeRefinementSeeds < 3) {
        safeRefinementSeeds += 1;
        jointRefineCandidatesTried += 1;
        const refined = refineJointSceneCandidate(nextPairs, camera, aspect, allComponents, characters, initialCollisions, sceneScale, { preserveFootprintTopology: true });
        if (Number.isFinite(refined.rawError)) {
          fitted = refined.fitted;
          refinementConstraintHits = refined.constraintHits;
          refinementSearch = refined.search;
          evaluatedPairs = pairs.map((pair, index) => ({ ...pair, component: fitted[index] }));
          candidateCarried = carryFittedParentMotion(fitted, allComponents);
          jointRefineCandidatesAccepted += 1;
          jointRefineBestScoreBefore = Math.min(jointRefineBestScoreBefore, refined.initialScore);
          jointRefineBestScoreAfter = Math.min(jointRefineBestScoreAfter, refined.score);
        }
      }
      const cameraError = cameraFitError(evaluatedPairs, camera, aspect);
      const evidenceError = sceneEvidenceError(evaluatedPairs, camera, aspect, candidateCarried.components, sceneScale);
      const refinedCollisions = fitCollisionPairs(originalScene, [...candidateCarried.components, ...characterOriginal]);
      if (introducesMajorOverlap(refinedCollisions, originalScene, initialCollisions)) {
        footprintOverlapRejectedCandidateCount += 1;
        recordMajorOverlapRejects(refinedCollisions, candidateCarried.components);
        continue;
      }
      const movement = fitted.reduce((sum, component, index) => sum + Math.hypot(
        component.position[0] - pairs[index].component.position[0],
        component.position[2] - pairs[index].component.position[2],
      ), 0) / Math.max(1, fitted.length);
      const carriedById = new Map(candidateCarried.components.map((component) => [component.id, component]));
      const originalById = new Map(originalScene.map((component) => [component.id, component]));
      const reviewPenalty = refinedCollisions.reduce((sum, collision) => {
        if (collision.classification !== "review") return sum;
        const left = carriedById.get(collision.firstId) ?? originalById.get(collision.firstId);
        const right = carriedById.get(collision.secondId) ?? originalById.get(collision.secondId);
        return sum + (left && right ? 0.12 * Math.min(1, fitPairPenetration(left, right) / Math.max(0.5, sceneScale)) : 0);
      }, 0);
      const dimensionPrior = usableFootprintPairIndices.reduce((sum, index) => {
        const original = pairs[index].component, fittedComponent = fitted[index];
        const originalRatio = original.size[0] / original.size[2], fittedRatio = fittedComponent.size[0] / fittedComponent.size[2];
        return sum + Math.abs(Math.log(fittedComponent.size[0] / original.size[0])) + Math.abs(Math.log(fittedComponent.size[1] / original.size[1]))
          + Math.abs(Math.log(fittedComponent.size[2] / original.size[2])) + Math.abs(Math.log(fittedRatio / originalRatio));
      }, 0) / usableFootprintPairIndices.length;
      const score = cameraError + evidenceError + reviewPenalty + 0.02 * movement / sceneScale + 0.045 * dimensionPrior;
      if (!best || score < best.error) { best = { camera, error: score, rawError: cameraError, components: fitted, movement, refinementConstraintHits, refinementSearch }; selectedBranch = "footprint"; }
    }
  }
  if (useFootprintCameraCandidates && !best) {
    const spatialEvidenceTrace = {
      selectedBranch: "none" as const,
      sourceFootprintIds: pairs.filter((pair) => pair.groundFootprints?.some((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55)).map((pair) => pair.component.id),
      eligiblePairIds: usableFootprintPairIndices.map((index) => pairs[index].component.id),
      uniqueCameraCandidateCount: uniqueCandidates.length,
      initializedCameraCandidateCount: initializedFootprintCandidateCount,
      jointRefineCandidatesTried,
      jointRefineCandidatesAccepted,
      jointRefineBestScoreBefore: Number.isFinite(jointRefineBestScoreBefore) ? jointRefineBestScoreBefore : null,
      jointRefineBestScoreAfter: Number.isFinite(jointRefineBestScoreAfter) ? jointRefineBestScoreAfter : null,
      axisConsistentCandidateIncluded,
      axisConsistentCandidateError,
      safePoseDiverseCandidateCount,
      preselectionSafeFootprintCandidateCount: preselectionSafeCandidateCount,
      postSelectionFootprintCandidateCount: candidates.length,
      targetSafeFootprintCandidateCount,
      safetyCheckStoppedEarly,
      initializedFootprintIds: rankedCandidates.find((candidate): candidate is typeof candidate & { initialized: LayoutDraftComponent[] } => "initialized" in candidate)
        ?.initialized.filter((component) => component.groundFootprint?.length).map((component) => component.id) ?? [],
      safetyCheckedFootprintCandidateCount,
      failedInitializationById: [...new Map([...failedFootprintInitialization, ...failedJointInitialization].map(([id, cameraCount]) => [id, (failedFootprintInitialization.get(id) ?? 0) + (failedJointInitialization.get(id) ?? 0)]))]
        .filter(([, cameraCount]) => cameraCount > 0).map(([id, cameraCount]) => ({ id, cameraCount })),
      footprintOverlapRejectedCandidateCount,
      majorOverlapRejects: [...majorOverlapRejects.values()],
      selectedInitializedIds: [], selectedAfterCarryIds: [], returnedByFitIds: [],
    };
    return { camera: fallback, before, best: undefined, bestCandidate: undefined, cameraOnlyBest: bestCameraOnly?.rawError,
      count: pairs.length, candidateCount: candidates.length, rejectionReason: "no-safe-candidate" as const,
      qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], spatialEvidenceTrace,
      movedCount: 0, movedComponentCount: 0, movement: 0, collisionPairs: initialCollisions,
      physicalValidity: initialPhysicalValidity, passedErrorThreshold: undefined };
  }
  // Legacy bbox-only observations can calibrate a camera, but they do not give
  // enough floor/depth evidence to rewrite object transforms. Keep geometry
  // fixed even when coarse proxy boxes overlap; preserve those overlaps as
  // diagnostics instead of using them to unlock a speculative joint fit.
  if (bestCameraOnly && !hasSpatialEvidence) {
    best = { camera: bestCameraOnly.camera, error: bestCameraOnly.rawError, rawError: bestCameraOnly.rawError, components: pairs.map(({ component }) => component), movement: 0 };
  }
  for (const camera of best ? [] : candidates) {
    const initialization = hasSpatialEvidence ? initializeObservedFootprints(pairs, camera, aspect) : { components: pairs.map(({ component }) => component), failedEvidenceIds: [] as string[] };
    if (initialization.failedEvidenceIds.length) {
      for (const id of initialization.failedEvidenceIds) failedJointInitialization.set(id, (failedJointInitialization.get(id) ?? 0) + 1);
      continue;
    }
    const initializedPairs = pairs.map((pair, index) => ({ ...pair, component: initialization.components[index] }));
    const option = refineJointSceneCandidate(initializedPairs, camera, aspect, allComponents, characters, initialCollisions, sceneScale);
    if (Number.isFinite(option.rawError)) {
      const fittedRoots = option.fitted;
      const nextPairs = initializedPairs.map((pair, index) => ({ ...pair, component: fittedRoots[index] }));
      const rawError = cameraFitError(nextPairs, camera, aspect);
      const cameraOnlyError = cameraFitError(initializedPairs, camera, aspect);
      const carriedCandidate = carryFittedParentMotion(fittedRoots, allComponents);
      const characterFitted = characterCollisionComponents(characters, carriedCandidate.components);
      const candidateCollisions = fitCollisionPairs([...allComponents, ...characterOriginal], [...carriedCandidate.components, ...characterFitted]);
      if (introducesMajorOverlap(candidateCollisions, [...allComponents, ...characterOriginal], initialCollisions)) continue;
      const movement = option.movement;
      const score = option.score;
      if (!best || score < best.error) { best = { camera, error: score, rawError, components: fittedRoots, movement, refinementConstraintHits: option.constraintHits, refinementSearch: option.search }; selectedBranch = "joint"; }
    }
  }
  if (!best || !Number.isFinite(best.rawError)) return { camera: fallback, before, best: undefined, bestCandidate: undefined, cameraOnlyBest: bestCameraOnly?.rawError, count: pairs.length, candidateCount: candidates.length, rejectionReason: "no-safe-candidate" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: 0, collisionPairs: initialCollisions, physicalValidity: initialPhysicalValidity, passedErrorThreshold: undefined };
  // Once camera-only fitting meets the same acceptance threshold, keep every
  // observed object and its support/partOf relationships fixed.
  if (bestCameraOnly && !hasSpatialEvidence) {
    best = { camera: bestCameraOnly.camera, error: bestCameraOnly.rawError, rawError: bestCameraOnly.rawError, components: pairs.map(({ component }) => component), movement: 0 };
  }
  const bestCandidate = { position: best.camera.position, target: best.camera.target, fov: best.camera.fov };
  const movedCount = best.components.filter((component, index) => {
    const original = pairs[index].component.position;
    return Math.hypot(component.position[0] - original[0], component.position[2] - original[2]) > 0.05;
  }).length;
  if (best.error >= beforeObjective * 0.9 && !hasSpatialEvidence) return { camera: fallback, before, best: best.rawError, bestCandidate, cameraOnlyBest: bestCameraOnly?.rawError, count: pairs.length, candidateCount: candidates.length, rejectionReason: "insufficient-improvement" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: best.movement, collisionPairs: initialCollisions, physicalValidity: initialPhysicalValidity, passedErrorThreshold: undefined };
  const carried = carryFittedParentMotion(best.components, allComponents);
  const selectedInitializedIds = best.components.filter((component) => component.groundFootprint?.length).map((component) => component.id);
  const selectedAfterCarryIds = carried.components.filter((component) => component.groundFootprint?.length).map((component) => component.id);
  const returnedComponents = carried.components.filter((component) => {
    const original = allComponents.find((candidate) => candidate.id === component.id);
    return original && (component.position.some((value, index) => Math.abs(value - original.position[index]) > 1e-4)
      || component.size.some((value, index) => Math.abs(value - original.size[index]) > 1e-4)
      || JSON.stringify(component.groundFootprint) !== JSON.stringify(original.groundFootprint));
  });
  const spatialEvidenceTrace = {
    selectedBranch,
    sourceFootprintIds: pairs.filter((pair) => pair.groundFootprints?.some((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55)).map((pair) => pair.component.id),
    eligiblePairIds: usableFootprintPairIndices.map((index) => pairs[index].component.id),
    uniqueCameraCandidateCount: uniqueCandidates.length,
    initializedCameraCandidateCount: initializedFootprintCandidateCount,
    jointRefineCandidatesTried,
    jointRefineCandidatesAccepted,
    jointRefineBestScoreBefore: Number.isFinite(jointRefineBestScoreBefore) ? jointRefineBestScoreBefore : null,
    jointRefineBestScoreAfter: Number.isFinite(jointRefineBestScoreAfter) ? jointRefineBestScoreAfter : null,
    axisConsistentCandidateIncluded,
    axisConsistentCandidateError,
    safePoseDiverseCandidateCount,
    selectedRefinementConstraintHits: best.refinementConstraintHits ?? [],
    selectedRefinementSearch: best.refinementSearch ?? null,
    preselectionSafeFootprintCandidateCount: preselectionSafeCandidateCount,
    postSelectionFootprintCandidateCount: candidates.length,
    targetSafeFootprintCandidateCount,
    safetyCheckStoppedEarly,
    initializedFootprintIds: rankedCandidates.find((candidate): candidate is typeof candidate & { initialized: LayoutDraftComponent[] } => "initialized" in candidate)
      ?.initialized.filter((component) => component.groundFootprint?.length).map((component) => component.id) ?? [],
    safetyCheckedFootprintCandidateCount,
    failedInitializationById: [...new Map([...failedFootprintInitialization, ...failedJointInitialization].map(([id, cameraCount]) => [id, (failedFootprintInitialization.get(id) ?? 0) + (failedJointInitialization.get(id) ?? 0)]))]
      .filter(([, cameraCount]) => cameraCount > 0).map(([id, cameraCount]) => ({ id, cameraCount })),
    footprintOverlapRejectedCandidateCount,
    majorOverlapRejects: [...majorOverlapRejects.values()],
    selectedInitializedIds,
    selectedAfterCarryIds,
    returnedByFitIds: returnedComponents.map((component) => component.id),
  };
  const roomBoundaryViolations = getRoomBoundaryViolations(carried.components);
  const withinRoom = roomBoundaryViolations.length === 0;
  const characterFitted = characterCollisionComponents(characters, carried.components);
  const collisionPairs = fitCollisionPairs([...allComponents, ...characterOriginal], [...carried.components, ...characterFitted]);
  const finalCollisionCounts = summarizeFitCollisions(collisionPairs);
  const hardCollisionCount = finalCollisionCounts.hard;
  const cameraOutsideGeometry = !cameraInsideGeometry(best.camera.position, carried.components);
  const finalPenetrationMeters = summarizeFitPenetration(collisionPairs);
  const unresolvedRigidPenetration = hardCollisionCount > 0
    && (hardCollisionCount > initialCollisionCounts.hard || finalPenetrationMeters >= initialPenetrationMeters - 1e-3);
  if (!cameraOutsideGeometry || unresolvedRigidPenetration) {
    return { camera: fallback, before, best: best.rawError, bestCandidate, cameraOnlyBest: bestCameraOnly?.rawError, count: pairs.length, candidateCount: candidates.length, rejectionReason: hardCollisionCount ? "unsafe-collision" as const : "no-safe-candidate" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: best.movement, collisionPairs, physicalValidity: { withinRoom, roomBoundsEvaluated: Boolean(floor), cameraOutsideGeometry, cameraGeometryEvaluated: true, hardCollisionCount, initialCollisionCounts, finalCollisionCounts, initialPenetrationMeters, finalPenetrationMeters, roomBoundaryViolations } };
  }
  if (best.rawError > 0.22) return {
    camera: { ...best.camera, projection: "perspective" as const, confidence: fallback.confidence, source: "estimated" as const, imageAspectRatio: aspect },
    before, best: best.rawError, bestCandidate, count: pairs.length, candidateCount: candidates.length,
    rejectionReason: "error-too-high" as const, qualityStatus: "needsReview" as const,
    cameraOnlyBest: bestCameraOnly?.rawError,
    components: returnedComponents, spatialEvidenceTrace, movedCount, movedComponentCount: carried.movedComponentCount, movement: best.movement, collisionPairs, physicalValidity: { withinRoom, roomBoundsEvaluated: Boolean(floor), cameraOutsideGeometry, cameraGeometryEvaluated: true, hardCollisionCount, initialCollisionCounts, finalCollisionCounts, initialPenetrationMeters, finalPenetrationMeters, roomBoundaryViolations }, passedErrorThreshold: false,
  };
  return {
    camera: { ...best.camera, projection: "perspective" as const, confidence: clamp(0.4 * (1 - best.rawError / 0.22), 0.05, 0.35), source: "estimated" as const, imageAspectRatio: aspect },
    before,
    best: best.rawError,
    bestCandidate,
    count: pairs.length,
    candidateCount: candidates.length,
    rejectionReason: null,
    qualityStatus: "needsReview" as const,
    cameraOnlyBest: bestCameraOnly?.rawError,
    components: returnedComponents,
    spatialEvidenceTrace,
    movedCount,
    movedComponentCount: carried.movedComponentCount,
    movement: best.movement,
    collisionPairs,
    physicalValidity: { withinRoom, roomBoundsEvaluated: Boolean(floor), cameraOutsideGeometry, cameraGeometryEvaluated: true, hardCollisionCount, initialCollisionCounts, finalCollisionCounts, initialPenetrationMeters, finalPenetrationMeters, roomBoundaryViolations },
    passedErrorThreshold: true,
  };
}

function cameraInsideGeometry(position: [number, number, number], components: readonly LayoutDraftComponent[]) {
  return cameraContainingGeometryIds(position, components).length > 0;
}

function cameraContainingGeometryIds(position: [number, number, number], components: readonly LayoutDraftComponent[]) {
  return components.filter((component) => {
    if (component.category === "ground") return false;
    const radians = getLayoutComponentRotationYDegrees(component) * Math.PI / 180;
    const dx = position[0] - component.position[0];
    const dz = position[2] - component.position[2];
    const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
    const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
    return Math.abs(localX) < component.size[0] / 2
      && Math.abs(localZ) < component.size[2] / 2
      && position[1] > component.position[1]
      && position[1] < component.position[1] + component.size[1];
  }).map((component) => component.id);
}

export function fitReferenceCamera(pairs: readonly CameraFitPair[], fallback: LayoutDraft["referenceCamera"], aspect: number, allComponents: readonly LayoutDraftComponent[]) {
  if (pairs.length < 3 || !fallback) return { camera: fallback, before: undefined, best: undefined, bestCandidate: undefined, count: pairs.length, candidateCount: 0, rejectionReason: "insufficient-evidence" as const };
  const before = cameraFitError(pairs, fallback, aspect);
  let best: { camera: { position: [number, number, number]; target: [number, number, number]; fov: number }; error: number } | undefined;
  const candidates = cameraCandidates(pairs, allComponents, aspect, fallback);
  for (const candidate of candidates) {
    const error = cameraFitError(pairs, candidate, aspect);
    if (!best || error < best.error) best = { camera: candidate, error };
  }
  if (!best || !Number.isFinite(best.error)) {
    return { camera: fallback, before, best: undefined, bestCandidate: undefined, count: pairs.length, candidateCount: candidates.length, rejectionReason: "no-safe-candidate" as const };
  }
  const bestCandidate = { position: best.camera.position, target: best.camera.target, fov: best.camera.fov };
  if (!Number.isFinite(before) || best.error >= before * 0.9) {
    return { camera: fallback, before, best: best.error, bestCandidate, count: pairs.length, candidateCount: candidates.length, rejectionReason: "insufficient-improvement" as const };
  }
  if (best.error > 0.22) {
    return { camera: fallback, before, best: best.error, bestCandidate, count: pairs.length, candidateCount: candidates.length, rejectionReason: "error-too-high" as const };
  }
  return {
    camera: { ...best.camera, projection: "perspective" as const, confidence: clamp(0.4 * (1 - best.error / 0.22), 0.05, 0.35), source: "bounds-fallback" as const, imageAspectRatio: aspect },
    before,
    best: best.error,
    bestCandidate,
    count: pairs.length,
    candidateCount: candidates.length,
    rejectionReason: null,
  };
}

function constrainToSupportFootprint(
  position: [number, number, number],
  size: [number, number, number],
  yawDegrees: number,
  support: { position: [number, number, number]; size: [number, number, number]; rotationYDegrees: number; category: DirectorLayoutCategory },
) {
  const childRadians = yawDegrees * Math.PI / 180;
  const supportRadians = support.rotationYDegrees * Math.PI / 180;
  const childCorners = [-1, 1].flatMap((xSign) => [-1, 1].map((zSign) => {
    const childX = xSign * size[0] / 2;
    const childZ = zSign * size[2] / 2;
    return [
      Math.cos(childRadians) * childX + Math.sin(childRadians) * childZ,
      -Math.sin(childRadians) * childX + Math.cos(childRadians) * childZ,
    ] as const;
  }));
  const supportLocalCorners = childCorners.map(([worldX, worldZ]) => [
    Math.cos(supportRadians) * worldX - Math.sin(supportRadians) * worldZ,
    Math.sin(supportRadians) * worldX + Math.cos(supportRadians) * worldZ,
  ] as const);
  const halfX = Math.max(...supportLocalCorners.map(([x]) => Math.abs(x)));
  const halfZ = Math.max(...supportLocalCorners.map(([, z]) => Math.abs(z)));
  const dx = position[0] - support.position[0];
  const dz = position[2] - support.position[2];
  const localX = Math.cos(supportRadians) * dx - Math.sin(supportRadians) * dz;
  const localZ = Math.sin(supportRadians) * dx + Math.cos(supportRadians) * dz;
  const availableX = support.size[0] / 2 - halfX;
  const availableZ = support.size[2] / 2 - halfZ;
  const tooLarge = availableX < 0 || availableZ < 0;
  const constrainedX = availableX < 0 ? 0 : clamp(localX, -availableX, availableX);
  const constrainedZ = availableZ < 0 ? 0 : clamp(localZ, -availableZ, availableZ);
  const worldOffsetX = Math.cos(supportRadians) * constrainedX + Math.sin(supportRadians) * constrainedZ;
  const worldOffsetZ = -Math.sin(supportRadians) * constrainedX + Math.cos(supportRadians) * constrainedZ;
  const corrected: [number, number, number] = [support.position[0] + worldOffsetX, position[1], support.position[2] + worldOffsetZ];
  return {
    position: corrected,
    adjusted: Math.abs(corrected[0] - position[0]) > 1e-6 || Math.abs(corrected[2] - position[2]) > 1e-6,
    tooLarge,
  };
}

function isOpening(category: DirectorLayoutCategory) {
  return category === "door" || category === "window";
}

function supportChainHasCycle(item: ImageObservationItem, itemById: Map<string, ImageObservationItem>) {
  const seen = new Set<string>([item.id]);
  let current = item;
  while (current.supportId) {
    const next = itemById.get(current.supportId);
    if (!next) return false;
    if (seen.has(next.id)) return true;
    seen.add(next.id);
    current = next;
  }
  return false;
}

function canonicalComponentReference(id: string, foldedPartParents: Map<string, string>) {
  let current = id;
  const seen = new Set<string>();
  while (foldedPartParents.has(current) && !seen.has(current)) {
    seen.add(current);
    current = foldedPartParents.get(current)!;
  }
  return current;
}

function hasTrustedPlacementChain(
  item: ImageObservationItem,
  itemById: Map<string, ImageObservationItem>,
  generated: Map<string, { position: [number, number, number]; size: [number, number, number]; rotationYDegrees: number; category: DirectorLayoutCategory }>,
  resolveReferenceId: (id: string) => string,
) {
  if (!item.placement || item.placement === "unknown" || item.placement === "wall_attached") return false;
  if (supportChainHasCycle(item, itemById)) return false;
  if (item.placement === "floor") {
    if (!item.supportId) return true;
    return generated.get(resolveReferenceId(item.supportId))?.category === "ground";
  }
  if (item.placement !== "supported" || !item.supportId) return false;
  let current = item;
  const seen = new Set([item.id]);
  while (current.supportId) {
    const supportId = resolveReferenceId(current.supportId);
    if (seen.has(supportId)) return false;
    seen.add(supportId);
    const supportComponent = generated.get(supportId);
    if (!supportComponent) return false;
    if (supportComponent.category === "ground") return true;
    const supportItem = itemById.get(supportId);
    if (!supportItem || !supportItem.placement || supportItem.placement === "unknown" || supportItem.placement === "wall_attached") return false;
    if (supportItem.placement === "floor" && !supportItem.supportId) return true;
    if (supportItem.placement === "floor") {
      current = supportItem;
      continue;
    }
    if (supportItem.placement !== "supported") return false;
    current = supportItem;
  }
  return false;
}

function hasLowFlatSupportChain(
  item: ImageObservationItem,
  itemById: Map<string, ImageObservationItem>,
  generated: Map<string, { position: [number, number, number]; size: [number, number, number]; rotationYDegrees: number; category: DirectorLayoutCategory }>,
  resolveReferenceId: (id: string) => string,
) {
  if (item.placement === "floor") return !item.supportId || generated.get(resolveReferenceId(item.supportId))?.category === "ground";
  if (item.placement !== "supported" || !item.supportId || supportChainHasCycle(item, itemById)) return false;
  let current = item;
  const seen = new Set([item.id]);
  let traversedLowFlatSupport = false;
  while (current.supportId) {
    const supportId = resolveReferenceId(current.supportId);
    if (seen.has(supportId)) return false;
    seen.add(supportId);
    const support = generated.get(supportId);
    if (!support) return false;
    if (support.category === "ground") return traversedLowFlatSupport;
    const footprint = Math.max(support.size[0], support.size[2]);
    const lowAndFlat = support.size[1] <= 0.18 && footprint >= 0.6
      && footprint / Math.max(0.01, support.size[1]) >= 5;
    if (!lowAndFlat) return false;
    traversedLowFlatSupport = true;
    const supportItem = itemById.get(supportId);
    if (!supportItem || supportItem.placement !== "supported" && supportItem.placement !== "floor") return false;
    current = supportItem;
  }
  return false;
}

function partOfChainHasCycle(item: ImageObservationItem, itemById: Map<string, ImageObservationItem>) {
  const seen = new Set<string>([item.id]);
  let current = item;
  while (current.partOfId) {
    const next = itemById.get(current.partOfId);
    if (!next) return false;
    if (seen.has(next.id)) return true;
    seen.add(next.id);
    current = next;
  }
  return false;
}

function isKnownRearPart(item: ImageObservationItem) {
  const type = (item.semanticType ?? "").toLowerCase();
  const name = item.name.toLowerCase();
  return ["headboard", "床头板", "backrest", "靠背", "rear_panel", "rear panel", "后背板", "后挡板"]
    .some((term) => type.includes(term) || name.includes(term));
}

function normalizedRearSide(item: ImageObservationItem, surfacesById: Map<string, ImageObservationSurface>, surfacesBySide: Map<ImageSurfaceSide, ImageObservationSurface[]>) {
  const side = item.contactWallSide;
  if (!side || side === "unknown" || side === "none") return undefined;
  const matches = (surfacesBySide.get(side) ?? []).filter((surface) => surface.kind === "wall");
  if (matches.length !== 1) return undefined;
  const legacy = item.againstSurfaceId ? surfacesById.get(item.againstSurfaceId) : undefined;
  if (legacy && legacy.id !== matches[0].id) return undefined;
  return side;
}

function relativeImageDirection(box: NormalizedImageBox, reference: NormalizedImageBox): ImageScreenDirection {
  const [x, y] = center(box);
  const [refX, refY] = center(reference);
  const dx = x - refX;
  const dy = y - refY;
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "image_left" : "image_right") : (dy < 0 ? "image_up" : "image_down");
}

function rearSideFromScreenDirection(direction: ImageScreenDirection): ContactWallSide | undefined {
  if (direction === "image_left" || direction === "image_right") return direction;
  if (direction === "image_up") return "image_back";
  return undefined;
}

function parentRearEvidenceConflicts(parent: ImageObservationItem, child: ImageObservationItem, side: ContactWallSide) {
  const wallDirection = side === "image_back" ? "image_up" : side;
  if (parent.bodyExtendsToward && parent.bodyExtendsToward !== "unknown") {
    const inferredRearSide = rearSideFromScreenDirection(({
      image_left: "image_right", image_right: "image_left", image_up: "image_down", image_down: "image_up",
    } as const)[parent.bodyExtendsToward]);
    if (inferredRearSide && inferredRearSide !== side) return true;
  }
  if (parent.rearFeature) {
    const featureDirection = relativeImageDirection(parent.rearFeature.bbox, parent.bbox);
    if (featureDirection !== wallDirection) return true;
  }
  // A child rear feature must extend behind the body in the opposite image direction.
  const childDirection = relativeImageDirection(child.bbox, parent.bbox);
  const expectedChildDirection = side === "image_back" ? "image_up" : side;
  if (childDirection !== expectedChildDirection) return true;
  return false;
}

function itemPosition(
  item: ImageObservationItem,
  size: [number, number, number],
  category: DirectorLayoutCategory,
  placement: ImageItemPlacement,
  surface: ImageObservationSurface | undefined,
  surfaceConflict: boolean,
  spaceType: LayoutSpaceType,
  support: { position: [number, number, number]; size: [number, number, number]; rotationYDegrees: number; category: DirectorLayoutCategory } | undefined,
  rearAnchorSurface?: ImageObservationSurface,
  floorSurface?: ImageObservationSurface,
  groundPosition?: [number, number, number],
  groundPlaneSupport = false,
): { position: [number, number, number]; yaw: number; uncertain: boolean; supportAdjusted: boolean; supportTooSmall: boolean } {
  const [cx, cy] = center(item.bbox);
  const isFloorLevelSupport = !support || support.category === "ground" || groundPlaneSupport;
  const isFloorPlaced = !isOpening(category) && placement !== "wall_attached" && isFloorLevelSupport;
  let position: [number, number, number] = [
    (cx - 0.5) * ROOM_WIDTH_METERS,
    0,
    (cy - 0.5) * ROOM_DEPTH_METERS,
  ];
  let yaw = 0;
  let uncertain = item.confidence < 0.65
    || !isVisible(item.visibility)
    || Boolean(surface && (surface.confidence < 0.65 || (item.againstSurfaceId && (surface.kind !== "wall" || surface.side === "unknown"))))
    || Boolean(item.againstSurfaceId && !surface)
    || surfaceConflict;

  const anchorSurface = rearAnchorSurface ?? (item.semanticType === "bed" && surface?.kind === "wall" && surface.side !== "unknown" ? surface : undefined);
  const anchorSide = anchorSurface?.side;
  if (anchorSide && anchorSurface?.kind === "wall") {
    yaw = wallYaw(anchorSide);
    const wallSize = wallDimensions(anchorSurface, spaceType)!;
    const along = anchorSide === "image_back"
      ? positionAlongObservedWall(item, anchorSurface, wallSize)
      : position[2];
    const halfDepth = size[2] / 2;
    position = positionAtWallInterior(anchorSurface, wallSize, halfDepth, along);
    uncertain = true; // bbox does not uniquely determine depth along the wall.
  } else if (placement === "wall_attached" && !isOpening(category) && surface?.kind === "wall" && surface.side !== "unknown") {
    yaw = wallYaw(surface.side);
    const wallSize = wallDimensions(surface, spaceType)!;
    position = positionOnWall(item, surface, wallSize, size);
    uncertain = true; // a single image does not establish wall depth or physical size.
  } else if (surface?.kind === "wall" && surface.side !== "unknown" && isOpening(category)) {
    yaw = wallYaw(surface.side);
    const wallSize = wallDimensions(surface, spaceType)!;
    const along = positionAlongObservedWall(item, surface, wallSize);
    const wallBoxHeight = Math.max(0.05, surface.bbox[3] - surface.bbox[1]);
    const verticalRatio = clamp((cy - surface.bbox[1]) / wallBoxHeight, 0, 1);
    const unboundedBottom = (1 - verticalRatio) * ROOM_HEIGHT_METERS - size[1] / 2;
    const desiredBottom = clamp(unboundedBottom, 0, ROOM_HEIGHT_METERS - size[1]);
    // Existing opening validation uses the wall's center plane and carves the opening there.
    if (surface.side === "image_right") position = [ROOM_WIDTH_METERS / 2, desiredBottom, along];
    else if (surface.side === "image_left") position = [-ROOM_WIDTH_METERS / 2, desiredBottom, along];
    else position = [along, desiredBottom, -ROOM_DEPTH_METERS / 2];
    uncertain ||= verticalRatio < 0.02 || verticalRatio > 0.98 || Math.abs(desiredBottom - unboundedBottom) > 0.15;
  } else if (surface?.kind === "wall" && surface.side !== "unknown") {
    // Furniture uses the same local -Z back-to-wall convention, while staying on the floor.
    yaw = wallYaw(surface.side);
    const wallSize = wallDimensions(surface, spaceType)!;
    const along = surface.side === "image_back"
      ? positionAlongObservedWall(item, surface, wallSize)
      : position[2];
    const halfDepth = size[2] / 2;
    position = positionAtWallInterior(surface, wallSize, halfDepth, along);
    uncertain = true; // a single image cannot establish the object's full depth/scale.
  } else if (!surface && !support && category !== "ground") {
    uncertain = true;
  }

  if (isFloorPlaced && !groundPosition) {
    // The bbox bottom is a rough ground-contact edge. Keep the visible front edge
    // at that depth, then place the object center behind it by its yaw-adjusted half depth.
    const contactZ = imageGroundContactZ(item, floorSurface);
    const halfExtentZ = worldZHalfExtent(size, yaw);
    const centerZ = clamp(contactZ - halfExtentZ, -ROOM_DEPTH_METERS / 2 + halfExtentZ, ROOM_DEPTH_METERS / 2 - halfExtentZ);
    if (anchorSide === "image_back" || surface?.kind === "wall" && surface.side === "image_back") {
      // A back-wall anchor owns the normal axis; the floor estimate only applies along the wall.
      const halfExtentX = worldXHalfExtent(size, yaw);
      position[0] = clamp(position[0], -ROOM_WIDTH_METERS / 2 + halfExtentX, ROOM_WIDTH_METERS / 2 - halfExtentX);
    } else {
      position[2] = centerZ;
    }
  }
  if (isFloorPlaced && groundPosition) position = [...groundPosition];

  let supportAdjusted = false;
  let supportTooSmall = false;
  if (support && support.category !== "ground" && !groundPlaneSupport) {
    const constrained = constrainToSupportFootprint(position, size, yaw, support);
    position = constrained.position;
    supportAdjusted = constrained.adjusted;
    supportTooSmall = constrained.tooLarge;
    uncertain ||= supportAdjusted || supportTooSmall;
  }
  return { position, yaw, uncertain, supportAdjusted, supportTooSmall };
}

/** Convert bounded image-space facts to the existing draft contract; bboxes remain estimates. */
export function imageObservationToLayoutDraft(
  input: unknown,
  source: LayoutDraftSource,
  options: ImageObservationLayoutOptions = {},
): LayoutDraft {
  const observation = parseObservation(input);
  if (typeof options.imageAspectRatio === "number" && Number.isFinite(options.imageAspectRatio)
    && options.imageAspectRatio >= 0.1 && options.imageAspectRatio <= 10) observation.imageAspectRatio = options.imageAspectRatio;
  const aspect = observation.imageAspectRatio ?? options.imageAspectRatio;
  const groundCamera = observation.geometryEvidence && aspect
    ? calibrateGroundCamera(observation.geometryEvidence, aspect)
    : undefined;
  const surfacesById = new Map(observation.surfaces.map((surface) => [surface.id, surface]));
  const surfacesBySide = new Map<ImageSurfaceSide, ImageObservationSurface[]>();
  for (const surface of observation.surfaces) {
    const matches = surfacesBySide.get(surface.side) ?? [];
    matches.push(surface);
    surfacesBySide.set(surface.side, matches);
  }
  const itemById = new Map(observation.items.map((item) => [item.id, item]));
  const skippedParts = new Set(observation.items.filter((item) => {
    const parent = item.partOfId ? itemById.get(item.partOfId) : undefined;
    // partOfId is a geometry contract: the child's visible shape is already
    // included by its parent. Honor that relation for arbitrary semantic types.
    return Boolean(parent && item.partOfId !== item.id && !partOfChainHasCycle(item, itemById));
  }).map((item) => item.id));
  const foldedPartParents = new Map([...skippedParts].flatMap((id) => {
    const parentId = itemById.get(id)?.partOfId;
    return parentId ? [[id, parentId] as const] : [];
  }));
  const resolveReferenceId = (id: string) => canonicalComponentReference(id, foldedPartParents);
  const rearAnchorByParent = new Map<string, { surface: ImageObservationSurface; conflict: boolean; childId: string }>();
  const rearChildrenByParent = new Map<string, Array<{ child: ImageObservationItem; surface: ImageObservationSurface }>>();
  for (const child of observation.items) {
    if (!child.partOfId || !isKnownRearPart(child) || child.confidence < 0.65 || !isVisible(child.visibility)) continue;
    const parent = itemById.get(child.partOfId);
    const side = normalizedRearSide(child, surfacesById, surfacesBySide);
    if (!parent || !side || parent.confidence < 0.65 || !isVisible(parent.visibility)) continue;
    const surface = (surfacesBySide.get(side) ?? []).find((candidate) => candidate.kind === "wall");
    if (!surface || surface.confidence < 0.65) continue;
    const candidates = rearChildrenByParent.get(parent.id) ?? [];
    candidates.push({ child, surface });
    rearChildrenByParent.set(parent.id, candidates);
  }
  for (const [parentId, candidates] of rearChildrenByParent) {
    const sides = new Set(candidates.map(({ surface }) => surface.side));
    const parent = itemById.get(parentId)!;
    const [{ child, surface }] = candidates;
    const conflict = sides.size !== 1 || candidates.some(({ child: candidate, surface: candidateSurface }) => parentRearEvidenceConflicts(parent, candidate, candidateSurface.side as ContactWallSide));
    rearAnchorByParent.set(parentId, { surface, conflict, childId: child.id });
  }
  const components: Array<Record<string, unknown>> = [];
  const relations: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const generated = new Map<string, { position: [number, number, number]; size: [number, number, number]; rotationYDegrees: number; category: DirectorLayoutCategory }>();

  for (const surface of observation.surfaces) {
    if (surface.kind === "floor") {
      const floorBoundaryCropped = surface.bbox[0] <= 0.01 || surface.bbox[1] <= 0.01
        || surface.bbox[2] >= 0.99 || surface.bbox[3] >= 0.99;
      components.push({
        id: surface.id, name: "识别到的地面", category: "ground", primitive: "box",
        // A visible floor bbox has no metric extent until a candidate camera
        // projects it. Keep only a non-authoritative placeholder here.
        position: [0, 0, 0], size: [0.1, 0.02, 0.1], rotationYDegrees: 0,
        confidence: Math.min(surface.confidence, 0.35), uncertain: true,
        visible: (surface.visibility ?? "visible") !== "occluded", ...(surface.mainColor ? { appearance: { color: surface.mainColor } } : {}),
        notes: `${BOX_NOTE}地面范围待按相机候选和可见轮廓反投影；该占位尺寸不代表真实房间范围。${floorBoundaryCropped ? "地面触及图像边界，需人工复核。" : ""}`,
      });
      generated.set(surface.id, { position: [0, 0, 0], size: [0.1, 0.02, 0.1], rotationYDegrees: 0, category: "ground" });
      observations.push({ componentId: surface.id, state: observationState(surface.visibility ?? "visible"), confidence: surface.confidence });
      continue;
    }
    const size = wallDimensions(surface, observation.spaceType ?? "unknown");
    if (!size) {
      observations.push({ state: "ambiguous", confidence: surface.confidence, evidence: "可见墙面方位无法映射到 canonical 图像基准，保留待确认。" });
      continue;
    }
    const position = wallPosition(surface, size, observation.spaceType ?? "unknown");
    const wallTopCropped = surface.bbox[1] <= 0.01;
    components.push({
      id: surface.id, name: `可见墙面 ${surface.side}`, category: "wall", primitive: "box",
      position, size, rotationYDegrees: 0, confidence: surface.confidence,
      uncertain: wallTopCropped || surface.confidence < 0.65 || !isVisible(surface.visibility ?? "visible"), visible: (surface.visibility ?? "visible") !== "occluded",
      ...(surface.mainColor ? { appearance: { color: surface.mainColor } } : {}),
      notes: wallTopCropped ? `${BOX_NOTE}墙顶触及图像上边界，2.8m墙高为先验估算，不视为完整测量值。` : BOX_NOTE,
    });
    generated.set(surface.id, { position, size, rotationYDegrees: 0, category: "wall" });
    observations.push({ componentId: surface.id, state: observationState(surface.visibility ?? "visible"), confidence: surface.confidence });
  }

  const pendingItems = observation.items.filter((item) => !skippedParts.has(item.id));
  while (pendingItems.length) {
    const readyIndex = pendingItems.findIndex((item) => {
      const supportId = item.supportId ? resolveReferenceId(item.supportId) : undefined;
      const supportReady = !supportId || generated.has(supportId) || !itemById.has(supportId) || supportChainHasCycle(item, itemById);
      const parentId = item.partOfId ? resolveReferenceId(item.partOfId) : undefined;
      const parentReady = !parentId || generated.has(parentId) || !itemById.has(parentId) || parentId === item.id;
      return supportReady && parentReady;
    });
    const [item] = pendingItems.splice(readyIndex < 0 ? 0 : readyIndex, 1);
    const category = categoryFor(item);
    const placement = effectivePlacement(item);
    const measuredSize = dimensionsFor(item, observation.imageAspectRatio ?? options.imageAspectRatio ?? 1);
    const size: [number, number, number] = placement === "wall_attached"
      ? [measuredSize[0], measuredSize[1], Math.min(measuredSize[2], 0.12)]
      : measuredSize;
    const legacySurface = item.againstSurfaceId ? surfacesById.get(item.againstSurfaceId) : undefined;
    const sideSpecified = item.contactWallSide !== undefined;
    const contactSide = item.contactWallSide;
    const sideMatches = contactSide && contactSide !== "unknown" && contactSide !== "none"
      ? (surfacesBySide.get(contactSide) ?? []).filter((candidate) => candidate.kind === "wall") : [];
    const sideSurface = sideMatches.length === 1 ? sideMatches[0] : undefined;
    const sideConflict = sideSpecified && (
      item.contactWallSide === "none" || item.contactWallSide === "unknown"
        ? Boolean(legacySurface)
        : !sideSurface || Boolean(legacySurface && legacySurface.id !== sideSurface.id)
    );
    const surface = sideSpecified ? (sideConflict ? undefined : sideSurface) : legacySurface;
    const surfaceConflict = sideConflict || Boolean(item.contactWallSide && sideMatches.length > 1);
    const supportCycle = supportChainHasCycle(item, itemById);
    const resolvedSupportId = item.supportId ? resolveReferenceId(item.supportId) : undefined;
    const support = resolvedSupportId && !supportCycle ? generated.get(resolvedSupportId) : undefined;
    const projectedFootprints = imageFootprintsToWorld(item, groundCamera, aspect ?? 1);
    let groundPosition: [number, number, number] | undefined;
    let footprintProjectionRejected: string | undefined;
    const supportItem = resolvedSupportId ? itemById.get(resolvedSupportId) : undefined;
    const supportIsGroundCover = Boolean(supportItem && supportItem.placement === "floor"
      && /(?:^|[_ -])(rug|carpet|mat|floor_cover|地毯|地垫|地毡)(?:$|[_ -])/i.test(`${supportItem.semanticType ?? ""} ${supportItem.name}`));
    const supportIsGroundPlane = !support || support.category === "ground" || supportIsGroundCover;
    if (supportIsGroundPlane && placement !== "wall_attached" && projectedFootprints.length) {
      const points = projectedFootprints.flatMap((part) => part.outer);
      const minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
      const minZ = Math.min(...points.map(([, z]) => z)), maxZ = Math.max(...points.map(([, z]) => z));
      const measuredWidth = maxX - minX, measuredDepth = maxZ - minZ;
      const projectionLimit = Math.max(ROOM_WIDTH_METERS, ROOM_DEPTH_METERS, (groundCamera?.cameraHeightMeters ?? 1.55) * 16);
      // Safety bounds follow the camera-height scale prior; they are not room dimensions.
      if (measuredWidth >= projectionLimit * 1e-4 && measuredDepth >= projectionLimit * 1e-4
        && measuredWidth <= projectionLimit && measuredDepth <= projectionLimit
        && [...points.flatMap(([x, z]) => [x, z])].every((value) => Math.abs(value) <= projectionLimit)) {
        size[0] = measuredWidth;
        size[2] = measuredDepth;
        groundPosition = [(minX + maxX) / 2, 0, (minZ + maxZ) / 2];
      } else footprintProjectionRejected = "footprint_projection_outside_camera_scale_safety_bound";
    }
    if (!groundPosition && supportIsGroundPlane && placement !== "wall_attached" && groundCamera && item.groundContacts?.length) {
      const contact = estimateGroundContactCenter(item.groundContacts, groundCamera, aspect ?? 1);
      // A single visible whole-object center can initialize XZ. Means of edge contacts stay advisory.
      const contactSafetyBound = Math.max(ROOM_WIDTH_METERS, ROOM_DEPTH_METERS, groundCamera.cameraHeightMeters * 16);
      if (contact && !contact.inferredCenter && contact.confidence >= 0.2
        && Math.abs(contact.position[0]) <= contactSafetyBound && Math.abs(contact.position[2]) <= contactSafetyBound) {
        groundPosition = contact.position;
      } else if (contact) footprintProjectionRejected = "ground_contact_outside_camera_scale_safety_bound";
    }
    const supportWasFolded = Boolean(item.supportId && resolvedSupportId !== item.supportId);
    const rearAnchor = rearAnchorByParent.get(item.id);
    // A placement says whether an item rests on the floor/support or mounts to a wall;
    // it does not erase a compatible observed wall contact. Only contradictory
    // wall-mounted-plus-supported evidence suppresses the wall anchor.
    const anchorIsOverridden = placement === "wall_attached" && Boolean(item.supportId);
    const positioningSurface = anchorIsOverridden ? undefined : rearAnchor?.conflict ? undefined : surface;
    const resolved = itemPosition(item, size, category, placement, positioningSurface, anchorIsOverridden ? false : surfaceConflict, observation.spaceType ?? "unknown", support,
      rearAnchor && !rearAnchor.conflict ? rearAnchor.surface : undefined,
      observation.surfaces.find((candidate) => candidate.kind === "floor"), groundPosition, supportIsGroundCover);
    const position = resolved.position;
    const yaw = resolved.yaw;
    const yawRadians = yaw * Math.PI / 180;
    let normalizedGroundFootprint: LayoutDraftComponent["groundFootprint"];
    if (groundPosition && projectedFootprints.length) {
      const toLocalWorld = ([x, z]: [number, number]): [number, number] => [
        Math.cos(yawRadians) * x - Math.sin(yawRadians) * z,
        Math.sin(yawRadians) * x + Math.cos(yawRadians) * z,
      ];
      const localParts = projectedFootprints.map((part) => ({ outer: part.outer.map(toLocalWorld), holes: part.holes.map((hole) => hole.map(toLocalWorld)), confidence: part.confidence }));
      const allLocal = localParts.flatMap((part) => part.outer);
      const minLocalX = Math.min(...allLocal.map(([x]) => x)), maxLocalX = Math.max(...allLocal.map(([x]) => x));
      const minLocalZ = Math.min(...allLocal.map(([, z]) => z)), maxLocalZ = Math.max(...allLocal.map(([, z]) => z));
      const correctedWidth = maxLocalX - minLocalX, correctedDepth = maxLocalZ - minLocalZ;
      if (correctedWidth > 0 && correctedDepth > 0) {
        size[0] = correctedWidth;
        size[2] = correctedDepth;
        const localCenterX = (minLocalX + maxLocalX) / 2, localCenterZ = (minLocalZ + maxLocalZ) / 2;
        position[0] = Math.cos(yawRadians) * localCenterX + Math.sin(yawRadians) * localCenterZ;
        position[2] = -Math.sin(yawRadians) * localCenterX + Math.cos(yawRadians) * localCenterZ;
        const supportFit = support && support.category !== "ground" && !supportIsGroundCover ? constrainToSupportFootprint(position, size, yaw, support) : undefined;
        if (supportFit) {
          position[0] = supportFit.position[0];
          position[2] = supportFit.position[2];
          if (supportFit.tooLarge) footprintProjectionRejected = "footprint_exceeds_explicit_support_surface";
        }
        const fittedLocalCenterX = Math.cos(yawRadians) * position[0] - Math.sin(yawRadians) * position[2];
        const fittedLocalCenterZ = Math.sin(yawRadians) * position[0] + Math.cos(yawRadians) * position[2];
        const normalized = localParts.map((part) => ({
          outer: part.outer.map((point) => [((point[0] - fittedLocalCenterX) / size[0]) + 0.5, ((point[1] - fittedLocalCenterZ) / size[2]) + 0.5] as [number, number]),
          ...(part.holes.length ? { holes: part.holes.map((hole) => hole.map((point) => [((point[0] - fittedLocalCenterX) / size[0]) + 0.5, ((point[1] - fittedLocalCenterZ) / size[2]) + 0.5] as [number, number])) } : {}),
          confidence: part.confidence,
        }));
        normalizedGroundFootprint = normalized.every((part) => [...part.outer, ...(part.holes ?? []).flat()].every(([x, z]) => x >= -1e-6 && x <= 1 + 1e-6 && z >= -1e-6 && z <= 1 + 1e-6)) ? normalized : undefined;
      }
    }
    const semanticType = item.semanticType;
    const observedWidth = (item.bbox[2] - item.bbox[0]) * (observation.imageAspectRatio ?? options.imageAspectRatio ?? 1);
    const observedHeight = item.bbox[3] - item.bbox[1];
    const descriptor = itemDescriptor(item);
    const ambiguousWideProp = category === "prop" && observedWidth >= observedHeight * 1.8 && !isFlatDecorationSemantic(descriptor);
    const incompatibleCategoryHint = Boolean(item.category === "window" && category === "prop") || semanticCategoryConflict(item, category);
    const uncertain = resolved.uncertain
      || Boolean(item.supportId && !support)
      || supportWasFolded
      || placement === "supported" && !support
      || Boolean(item.partOfId && (item.partOfId === item.id || !itemById.has(item.partOfId) || !skippedParts.has(item.id)))
      || Boolean(rearAnchor?.conflict)
      || Boolean(rearAnchor && surface && surface.id !== rearAnchor.surface.id)
      || Boolean(item.rearFeature || item.bodyExtendsToward && item.bodyExtendsToward !== "unknown")
      || placement === "wall_attached" && !surface
      || item.placement === "unknown"
      || incompatibleCategoryHint
      || Boolean(item.facingTowardId)
      || ambiguousWideProp
      || supportCycle;
    const parent = item.partOfId ? itemById.get(item.partOfId) : undefined;
    const notes = [
      BOX_NOTE,
      surfaceConflict ? "新旧墙面关系冲突或未能唯一匹配可见墙，保留估算位置并待确认。" : "",
      resolved.supportAdjusted ? "子物件 footprint 超出支撑面，已在支撑物实际旋转后的 footprint 内约束中心位置。" : "",
      resolved.supportTooSmall ? "子物件 footprint 大于支撑面；未缩放并居中，标记待确认。" : "",
      rearAnchor ? `父子后侧部件证据：${itemById.get(rearAnchor.childId)?.name ?? "子部件"} 接触 ${rearAnchor.surface.side}；父普通接墙仅表示接触，不替代后侧方向。${rearAnchor.conflict ? "与父级显式后侧方向证据冲突，未据此锚定。" : "已用于父体 local -Z 朝向约束。"}` : "",
      rearAnchor && surface && surface.id !== rearAnchor.surface.id ? "父普通接墙与后侧部件接墙不同，保留后侧部件朝向并待确认。" : "",
      item.rearFeature ? `可见背面特征：${item.rearFeature.name}；主体延伸方向：${item.bodyExtendsToward ?? "unknown"}，仅作观察证据。` : "",
      item.bodyExtendsToward && item.bodyExtendsToward !== "unknown" && !item.rearFeature ? `图像延伸方向=${item.bodyExtendsToward}；未把屏幕方向直接换算为世界朝向，保留待复核。` : "",
      placement === "wall_attached" && surface ? "按唯一可见墙面 bbox 估算挂接高度与墙面位置；深度和实际尺寸仍需复核，未视为建筑开口。" : "",
      placement === "wall_attached" && !surface ? "观察为墙面挂接物，但没有唯一可见墙面锚点；保留估算位置并待确认。" : "",
      placement === "supported" && !support ? "观察为受托物件，但支撑对象缺失或不可用；保留估算位置并待确认。" : "",
      supportWasFolded && support ? "原支撑对象已归入父组件；暂以父组件整体包围盒承接关系，具体接触面待复核。" : "",
      placement === "unknown" ? "物件的落地、承托或墙面挂接方式不明确；保留估算位置并待确认。" : "",
      incompatibleCategoryHint ? "基础几何类别与语义身份提示冲突；保留类别提供的几何含义，不用语义提示替换类别，待确认。" : "",
      item.partOfId && parent ? `图像子部件归入 ${parent.name}，不重复创建独立几何。` : "",
      item.partOfId && (!parent || !skippedParts.has(item.id)) ? "子部件未能确认已被父组件几何覆盖，保留独立几何并待确认。" : "",
      ambiguousWideProp ? "宽扁外观缺少明确形体语义（可能是屏幕、横幅或家具）；未按宽高比推断水平承载方向，尺寸待确认。" : "",
      footprintProjectionRejected ? `地面几何证据未应用：${footprintProjectionRejected}。` : "",
    ].filter(Boolean).join(" ");
    components.push({
      id: item.id, name: item.name, category, primitive: category === "pillar" ? "cylinder" : "box",
      position, size, rotationYDegrees: yaw, confidence: item.confidence,
      uncertain: uncertain || item.visibility !== "visible", visible: item.visibility !== "occluded",
      ...(semanticType ? { semanticType } : {}),
      ...(normalizedGroundFootprint ? { groundFootprint: normalizedGroundFootprint } : {}),
      ...(incompatibleCategoryHint ? {
        assembly: [{
          primitive: category === "pillar" ? "cylinder" as const : "box" as const,
          position: [0.5, 0.5, 0.5] as [number, number, number],
          size: [1, 1, 1] as [number, number, number],
        }],
      } : {}),
      ...(item.mainColor || (surface?.kind === "wall" && isOpening(category))
        ? { appearance: { ...(item.mainColor ? { color: item.mainColor } : {}), ...(surface?.kind === "wall" && isOpening(category) ? { frontDirectionDegrees: yaw } : {}) } }
        : {}),
      ...(support ? { supportComponentId: resolvedSupportId } : {}),
      ...(item.partOfId && generated.has(item.partOfId) ? { partOfComponentId: item.partOfId } : {}),
      notes,
    });
    generated.set(item.id, { position, size, rotationYDegrees: yaw, category });
    observations.push({ componentId: item.id, state: observationState(item.visibility), confidence: item.confidence, evidence: notes });
    const relationSurface = rearAnchor && !rearAnchor.conflict ? rearAnchor.surface : surface;
    if (relationSurface && generated.has(relationSurface.id)) {
      const usesLegacyBedHead = semanticType === "bed" && !item.contactWallSide && Boolean(item.againstSurfaceId);
      relations.push({ fromId: item.id, toId: relationSurface.id, type: semanticType === "bed" && (rearAnchor && !rearAnchor.conflict || usesLegacyBedHead) ? "head_at" : isOpening(category) || placement === "wall_attached" ? "attached_to" : "adjacent_to", confidence: Math.min(item.confidence, relationSurface.confidence) });
    } else if (item.againstSurfaceId || item.contactWallSide) {
      observations.push({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, 0.5), evidence: "墙面锚点不可用，保留估算位置并待确认。" });
    }
    if (rearAnchor?.conflict) observations.push({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, 0.5), evidence: "父级背面特征或延伸方向与已识别后侧子部件接墙证据冲突；未据此锚定，保留原观察待确认。" });
    if (item.supportId && resolvedSupportId && generated.has(resolvedSupportId)) {
      relations.push({ fromId: item.id, toId: resolvedSupportId, type: "supports", confidence: item.confidence });
    } else if (item.supportId) {
      observations.push({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, 0.5), evidence: "支撑锚点不可用，保留待确认。" });
    }
  }

  for (const child of observation.items.filter((item) => skippedParts.has(item.id))) {
    observations.push({
      componentId: child.partOfId,
      state: observationState(child.visibility),
      confidence: child.confidence,
      evidence: `图像可见子部件归入父组件 ${itemById.get(child.partOfId!)!.name}，不重复生成几何；保留原观察接墙字段 ${child.contactWallSide ?? "unknown"} 与 legacy 锚点 ${child.againstSurfaceId ?? "none"}。`,
    });
  }

  const observationPriority = (item: Record<string, unknown>) => {
    const state = item.state === "ambiguous" || item.state === "occluded" ? 0 : 1;
    const hasEvidence = typeof item.evidence === "string" ? 0 : 1;
    const score = typeof item.confidence === "number" ? item.confidence : 1;
    return [state, hasEvidence, score] as const;
  };
  observations.sort((left, right) => {
    const a = observationPriority(left);
    const b = observationPriority(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  relations.sort((left, right) => {
    const priority = (relation: Record<string, unknown>) => relation.type === "head_at" ? 0 : relation.type === "supports" ? 1 : relation.type === "attached_to" ? 2 : 3;
    return priority(left) - priority(right) || Number(right.confidence) - Number(left.confidence);
  });

  if (components.length === 0) throw new ImageObservationValidationError("没有可安全转换的可见墙面或物品", "geometry");
  const candidate = {
    spaceType: observation.spaceType,
    scale: { mode: "estimated", confidence: 0.3 },
    components,
    characters: (observation.people ?? []).map((person) => {
      const [cx, cy] = center(person.bbox);
      const support = person.supportId ? generated.get(person.supportId) : undefined;
      const facingDirection = person.facingDirection ?? "unknown";
      const rotationYDegrees = facingYawForCamera(facingDirection, undefined);
      return {
        id: person.id,
        name: person.name,
        // An explicit support relation owns the horizontal placement for a person;
        // do not reuse image height as a floor-depth estimate for supported subjects.
        position: support
          ? [support.position[0], 0, support.position[2]]
          : [(cx - 0.5) * ROOM_WIDTH_METERS, 0, (cy - 0.5) * ROOM_DEPTH_METERS],
        height: 1.7,
        rotationYDegrees,
        facingDirection,
        posture: person.posture ?? "unknown",
        ...(person.kneelVariant ? { kneelVariant: person.kneelVariant } : {}),
        ...(person.handGesture ? { handGesture: person.handGesture } : {}),
        bodyTypeHint: "unknown",
        ...(person.supportId ? { supportComponentId: person.supportId } : {}),
        confidence: person.confidence,
        uncertain: person.confidence < 0.65 || person.visibility !== "visible" || person.posture === "unknown" || facingDirection === "unknown",
        notes: `由二维 bbox 粗估平面位置；原图朝向=${facingDirection}；身高、朝向和姿态需人工复核。`,
        visible: person.visibility !== "occluded",
      };
    }),
    observations,
    relations,
  };
  const validated = validateLayoutDraftCandidate(candidate, source, {
    ...(observation.imageAspectRatio ? { imageAspectRatio: observation.imageAspectRatio } : {}),
    ...options,
  });
  const facingItems = observation.items.filter((item) => item.facingTowardId);
  const appendFacingReview = (entry: NonNullable<LayoutDraft["observations"]>[number]) => {
    const current = validated.observations ?? [];
    if (current.length < 12) validated.observations = [...current, entry];
    else if (!(validated.validationWarnings ?? []).includes("observations_truncated")) {
      validated.validationWarnings = [...(validated.validationWarnings ?? []), "observations_truncated"];
    }
  };
  const facingCycles = new Set<string>();
  const facingById = new Map(facingItems.map((item) => [item.id, item.facingTowardId!]));
  for (const start of facingById.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current && facingById.has(current)) {
      if (visited.has(current)) {
        for (const id of visited) facingCycles.add(id);
        break;
      }
      visited.add(current);
      current = facingById.get(current);
    }
  }
  const componentsById = new Map(validated.components.map((component) => [component.id, component]));
  const floor = validated.components.find((component) => component.category === "ground");
  // These bounds are only a weak placement prior for components without visual
  // anchors; they are not inferred from a floor proxy or treated as room truth.
  const roomBounds = { minX: -ROOM_WIDTH_METERS / 2, maxX: ROOM_WIDTH_METERS / 2, minZ: -ROOM_DEPTH_METERS / 2, maxZ: ROOM_DEPTH_METERS / 2 };
  for (const item of facingItems) {
    const component = componentsById.get(item.id);
    const targetItem = observation.items.find((candidate) => candidate.id === item.facingTowardId);
    const target = item.facingTowardId ? componentsById.get(item.facingTowardId) : undefined;
    let reason = "";
    if (!component || !targetItem || !target || item.facingTowardId === item.id) reason = "目标缺失或指向自身";
    else if (facingCycles.has(item.id)) reason = "朝向关系形成循环";
    else if (item.visibility !== "visible" || item.confidence < 0.75 || targetItem.visibility !== "visible" || targetItem.confidence < 0.75) reason = "朝向双方的可见性或置信度不足";
    else if (categoryFor(item) !== "chair") reason = "当前只对局部前向定义明确的椅子应用目标朝向";
    else if ((validated.relations?.length ?? 0) >= 24) reason = "关系记录达到上限";
    if (reason) {
      if (component) {
        component.uncertain = true;
        component.notes = [component.notes, `${reason}；未应用朝向，待复核。`].filter(Boolean).join(" ");
      }
      appendFacingReview({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, targetItem?.confidence ?? 0), evidence: `${reason}；未旋转物件。` });
      continue;
    }
    if (!component || !target || !targetItem) continue;
    const dx = target.position[0] - component.position[0];
    const dz = target.position[2] - component.position[2];
    if (Math.hypot(dx, dz) < 0.05) {
      component.uncertain = true;
      component.notes = [component.notes, "朝向目标与椅子中心重合；未应用朝向，待复核。"].filter(Boolean).join(" ");
      appendFacingReview({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, targetItem!.confidence), evidence: "朝向目标无法确定水平向量；未旋转物件。" });
      continue;
    }
    const proposedYaw = Math.atan2(dx, dz) * 180 / Math.PI; // Chair primitives use local +Z as their visible front.
    const support = item.supportId ? componentsById.get(item.supportId) : undefined;
    const supportItem = item.supportId ? itemById.get(item.supportId) : undefined;
    const supportIsGroundCover = Boolean(supportItem && supportItem.placement === "floor"
      && /(?:^|[_ -])(rug|carpet|mat|floor_cover|地毯|地垫|地毡)(?:$|[_ -])/i.test(`${supportItem.semanticType ?? ""} ${supportItem.name}`));
    const supportFit = support && support.category !== "ground" && !supportIsGroundCover
      ? constrainToSupportFootprint(component.position, component.size, proposedYaw, support)
      : undefined;
    const halfX = worldXHalfExtent(component.size, proposedYaw);
    const halfZ = worldZHalfExtent(component.size, proposedYaw);
    const outsideRoom = component.category !== "wall" && component.category !== "ground"
      && (component.position[0] - halfX < roomBounds.minX || component.position[0] + halfX > roomBounds.maxX
        || component.position[2] - halfZ < roomBounds.minZ || component.position[2] + halfZ > roomBounds.maxZ);
    const unchangedOnSupport = !supportFit || (!supportFit.tooLarge && !supportFit.adjusted);
    const nextComponents = validated.components.map((candidate) => candidate.id === component.id
      ? withLayoutComponentRotationYDegrees(candidate, proposedYaw)
      : candidate);
    const initialCollisions = fitCollisionPairs(validated.components, validated.components);
    const newCollisions = fitCollisionPairs(validated.components, nextComponents);
    if (outsideRoom || !unchangedOnSupport || introducesMajorOverlap(newCollisions, validated.components, initialCollisions)) {
      component.uncertain = true;
      component.notes = [component.notes, "目标朝向会越出房间、超出支撑面或造成碰撞；保留原朝向，待复核。"].filter(Boolean).join(" ");
      appendFacingReview({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, targetItem!.confidence), evidence: "朝向候选未通过房间、支撑面或碰撞检查；未旋转物件。" });
      continue;
    }
    Object.assign(component, withLayoutComponentRotationYDegrees(component, proposedYaw));
    component.uncertain = true;
    component.notes = [component.notes, `可见正面关系指向 ${target.name}；只应用朝向，位置保持不变。`].filter(Boolean).join(" ");
    validated.relations = [...(validated.relations ?? []), { fromId: item.id, toId: target.id, type: "faces", confidence: Math.min(item.confidence, targetItem!.confidence) }];
    appendFacingReview({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, targetItem!.confidence), evidence: `椅子局部 +Z 前向对准可见目标 ${target.name}；位置未移动，朝向估算待复核。` });
  }
  const reliableCameraCategories: DirectorLayoutCategory[] = ["table", "chair", "sofa", "cabinet", "prop"];
  const cameraObservationById = new Map(observation.items.map((item) => [item.id, item]));
  const selectedCameraItems = observation.items
    .filter((item) => item.confidence >= 0.75 && item.visibility === "visible" && !item.partOfId
      && reliableCameraCategories.includes(categoryFor(item))
      && effectivePlacement(item) !== "wall_attached"
      && hasTrustedPlacementChain(item, cameraObservationById, generated, resolveReferenceId)
      && (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]) >= 0.012)
    .sort((a, b) => ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) * b.confidence)
      - ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) * a.confidence))
    .slice(0, 10);
  const componentById = new Map(validated.components.map((component) => [component.id, component]));
  const fitPairs = selectedCameraItems.flatMap((item) => {
    const component = componentById.get(item.id);
    if (!component) return [];
    const wall = item.contactWallSide && item.contactWallSide !== "unknown" && item.contactWallSide !== "none"
      ? (surfacesBySide.get(item.contactWallSide) ?? []).find((candidate) => candidate.kind === "wall")
      : item.againstSurfaceId ? surfacesById.get(item.againstSurfaceId) : undefined;
    const support = item.supportId ? generated.get(item.supportId) : undefined;
    return [{
      bbox: item.bbox, confidence: item.confidence, component,
      ...(wall?.kind === "wall" ? { surfaceSide: wall.side } : {}),
      ...(item.groundContacts ? { groundContacts: item.groundContacts } : {}),
      ...(item.groundFootprints ? { groundFootprints: item.groundFootprints } : {}),
      ...(item.occludesIds ? { occludesIds: item.occludesIds } : {}),
      ...(observation.geometryEvidence ? { geometryEvidence: observation.geometryEvidence } : {}),
      ...(groundCamera ? { groundCamera: groundCamera.camera } : {}),
      onGround: effectivePlacement(item) !== "wall_attached" && (hasLowFlatSupportChain(item, cameraObservationById, generated, resolveReferenceId)
        || item.groundFootprints?.some((footprint) => footprint.visibility === "visible" && footprint.confidence >= 0.55) === true),
    }];
  });
  const baselineComponentsForSafety = validated.components.map((component) => ({
    ...component,
    position: [...component.position] as [number, number, number],
    size: [...component.size] as [number, number, number],
    ...(component.groundFootprint ? { groundFootprint: component.groundFootprint.map((part) => ({ ...part, outer: part.outer.map((point) => [...point] as [number, number]), ...(part.holes ? { holes: part.holes.map((hole) => hole.map((point) => [...point] as [number, number])) } : {}) })) } : {}),
  }));
  const baselineCharactersForSafety = validated.characters.map((character) => ({ ...character, position: [...character.position] as [number, number, number] }));
  const baselineCameraForSafety = validated.referenceCamera;
  const baselineCharacterCollisionComponents = characterCollisionComponents(baselineCharactersForSafety, baselineComponentsForSafety);
  const baselineSceneForSafety = [...baselineComponentsForSafety, ...baselineCharacterCollisionComponents];
  const baselineCollisionsForSafety = fitCollisionPairs(baselineSceneForSafety, baselineSceneForSafety);
  if (typeof aspect === "number" && Number.isFinite(aspect) && aspect >= 0.1 && aspect <= 10) {
    const fit = fitReferenceScene(fitPairs, validated.referenceCamera, aspect, validated.components, validated.characters);
    if (fit.rejectionReason === null && fit.components.length) {
      const fittedById = new Map(fit.components.map((component) => [component.id, component]));
      validated.components = validated.components.map((component) => {
        const fitted = fittedById.get(component.id);
        return fitted ? { ...component, position: [...fitted.position] as [number, number, number], size: [...fitted.size] as [number, number, number], uncertain: true,
          notes: [component.notes, "依据同图投影、平面占地和碰撞约束有限调整位置/尺寸；单图米制尺度仍为估算。"].filter(Boolean).join(" ").slice(0, 240) } : component;
      });
    }
    let pairDiagnostics = fit.camera ? cameraFitBreakdown(fitPairs, fit.camera, aspect).pairs.slice(0, 10) : [];
    let residualsForReview = fit.qualityStatus === "needsReview" ? dominantFitResiduals(fitPairs, pairDiagnostics) : [];
    if (fit.camera) validated.referenceCamera = {
      ...fit.camera,
      fitDiagnostics: {
        itemCount: fit.count,
        candidateCount: fit.candidateCount,
        baselineProjectionError: Number.isFinite(fit.before) ? fit.before! : null,
        bestProjectionError: Number.isFinite(fit.best) ? fit.best! : null,
        cameraOnlyBestProjectionError: Number.isFinite(fit.cameraOnlyBest) ? fit.cameraOnlyBest! : null,
        pairDiagnostics,
        bestCandidate: fit.bestCandidate ?? null,
        applied: fit.qualityStatus !== "unavailable",
        passedErrorThreshold: fit.passedErrorThreshold ?? (fit.best !== undefined && fit.best <= 0.22),
        qualityStatus: fit.qualityStatus,
        rejectionReason: fit.rejectionReason,
        movedGroundItems: fit.movedCount,
        movedComponents: fit.movedComponentCount,
        positionAdjustmentMeters: fit.movement,
        ...(fit.spatialEvidenceTrace ? { spatialEvidenceTrace: fit.spatialEvidenceTrace } : {}),
        collisionPairs: fit.collisionPairs,
        physicalValidity: fit.physicalValidity,
      },
    };
    if (fit.qualityStatus !== "unavailable") {
      const fittedById = new Map(fit.components.map((component) => [component.id, component]));
      validated.components = validated.components.map((component) => fittedById.get(component.id) ?? component);
    }
    // Keep the accepted candidate geometry so the later low-confidence wall/floor
    // alignment can be rolled back as one dependency group if it creates a new clash.
    const componentsBeforeSurfaceAlignment = new Map(validated.components.map((component) => [component.id, component]));
    const observedFloor = observation.surfaces.find((surface) => surface.kind === "floor");
    const projectedFloor = observedFloor && fit.camera ? projectVisibleFloorBounds(observedFloor.bbox, fit.camera, aspect) : undefined;
    if (observedFloor && projectedFloor) {
      validated.components = validated.components.map((component) => component.id !== observedFloor.id ? component : {
        ...component,
        position: projectedFloor.position,
        size: projectedFloor.size,
        confidence: Math.min(observedFloor.confidence, fit.camera?.confidence ?? 0.35, 0.35),
        uncertain: true,
        notes: "地面可见bbox按同一相机候选反投影；透视裁切和单图尺度有歧义，extent仅作低置信参考。",
      });
      if (fit.physicalValidity) {
        // A projected visible floor bbox is only a soft image envelope, never a
        // complete room boundary, even when none of its corners touch the image edge.
        fit.physicalValidity.roomBoundsEvaluated = false;
        fit.physicalValidity.roomBoundaryViolations = [];
        fit.physicalValidity.withinRoom = false;
      }
      const floorMinX = projectedFloor.position[0] - projectedFloor.size[0] / 2;
      const floorMaxX = projectedFloor.position[0] + projectedFloor.size[0] / 2;
      const floorMinZ = projectedFloor.position[2] - projectedFloor.size[2] / 2;
      const floorMaxZ = projectedFloor.position[2] + projectedFloor.size[2] / 2;
      const wallById = new Map(observation.surfaces.filter((surface) => surface.kind === "wall").map((surface) => [surface.id, surface]));
      const wallBySide = new Map(observation.surfaces.filter((surface) => surface.kind === "wall").map((surface) => [surface.side, surface]));
      validated.components = validated.components.map((component) => {
        if (component.category !== "wall") return component;
        const wall = wallById.get(component.id);
        if (!wall || wall.side === "unknown" || wall.side === "floor") return component;
        const size: [number, number, number] = wall.side === "image_back"
          ? [projectedFloor.size[0], component.size[1], component.size[2]]
          : [component.size[0], component.size[1], projectedFloor.size[2]];
        const position: [number, number, number] = wall.side === "image_back"
          ? [projectedFloor.position[0], component.position[1], floorMinZ]
          : [wall.side === "image_left" ? floorMinX : floorMaxX, component.position[1], projectedFloor.position[2]];
        return { ...component, position, size, uncertain: true, confidence: Math.min(component.confidence, 0.35),
          notes: [component.notes, "墙面平面按同一候选相机与可见地面bbox作低置信坐标对齐；地面bbox只是软包络，不代表完整房间边界。"].filter(Boolean).join(" ").slice(0, 240) };
      });
      const observedItemsById = new Map(observation.items.map((item) => [item.id, item]));
      const componentById = new Map(validated.components.map((component) => [component.id, component]));
      validated.components = validated.components.map((component) => {
        const item = observedItemsById.get(component.id);
        if (!item || effectivePlacement(item) !== "wall_attached") return component;
        const wall = item.againstSurfaceId ? wallById.get(item.againstSurfaceId)
          : item.contactWallSide && item.contactWallSide !== "unknown" && item.contactWallSide !== "none" ? wallBySide.get(item.contactWallSide) : undefined;
        const wallComponent = wall ? componentById.get(wall.id) : undefined;
        if (!wall || !wallComponent || wall.side === "unknown" || wall.side === "floor") return component;
        const relativeX = clamp(((item.bbox[0] + item.bbox[2]) / 2 - wall.bbox[0]) / Math.max(0.05, wall.bbox[2] - wall.bbox[0]), 0, 1);
        const relativeY = clamp(((item.bbox[1] + item.bbox[3]) / 2 - wall.bbox[1]) / Math.max(0.05, wall.bbox[3] - wall.bbox[1]), 0, 1);
        const position: [number, number, number] = wall.side === "image_back"
          ? [floorMinX + relativeX * projectedFloor.size[0], component.position[1], floorMinZ + WALL_THICKNESS_METERS]
          : [wall.side === "image_left" ? floorMinX + WALL_THICKNESS_METERS : floorMaxX - WALL_THICKNESS_METERS,
            component.position[1], floorMinZ + relativeY * projectedFloor.size[2]];
        return { ...component, position, uncertain: true,
          notes: [component.notes, "墙面挂接位置按可见墙bbox比例映射到同一候选地面坐标系；墙地边界与像素比例仅为低置信估算。"].filter(Boolean).join(" ").slice(0, 240) };
      });
    }
    const collisionReviewIds = new Set(fit.collisionPairs
      .filter((pair) => pair.classification !== "allowed")
      .flatMap((pair) => [pair.firstId, pair.secondId])
      .filter((id) => !id.startsWith("character:")));
    if (collisionReviewIds.size) {
      validated.components = validated.components.map((component) => {
        if (!collisionReviewIds.has(component.id)) return component;
        const note = "与其他可见组件存在包围盒候选重叠，代理几何无法确认网格穿透，待复核。";
        return component.notes?.includes(note)
          ? { ...component, uncertain: true }
          : { ...component, uncertain: true, notes: [component.notes, note].filter(Boolean).join(" ") };
      });
    }
    if (residualsForReview.length) {
      const residualById = new Map(residualsForReview.map(({ pair, diagnostic }) => [pair.component.id, diagnostic]));
      validated.components = validated.components.map((component) => {
        const residual = residualById.get(component.id);
        if (!residual) return component;
        const note = `投影框与原图观察不一致（中心偏差 ${residual.centerError.toFixed(2)}、宽高尺度偏差 ${residual.scaleError.toFixed(2)}）；位置/尺寸约束候选${fit.rejectionReason === null ? "已有限应用" : "未应用"}，遮挡与物件轮廓仍需复核。`;
        return { ...component, uncertain: true, notes: [component.notes, note].filter(Boolean).join(" ") };
      });
      validated.observations = (validated.observations ?? []).map((observation) => {
        const residual = observation.componentId ? residualById.get(observation.componentId) : undefined;
        if (!residual) return observation;
        const note = `投影框与观察框不一致（中心 ${residual.centerError.toFixed(2)}、尺度 ${residual.scaleError.toFixed(2)}）；几何或遮挡解释待确认。`;
        return { ...observation, state: "ambiguous" as const, evidence: [observation.evidence, note].filter(Boolean).join(" ") };
      });
    }
    const finalCamera = validated.referenceCamera;
    const finalComponents = new Map(validated.components.map((component) => [component.id, component]));
    validated.characters = validated.characters.map((character) => {
      const support = character.supportComponentId ? finalComponents.get(character.supportComponentId) : undefined;
      return {
        ...character,
        ...(support ? { position: [support.position[0], character.position[1], support.position[2]] as [number, number, number] } : {}),
        rotationYDegrees: facingYawForCamera(character.facingDirection ?? "unknown", finalCamera),
      };
    });
    const selectedCameraBeforeSafety = validated.referenceCamera;
    const selectedComponentsBeforeSafety = validated.components;
    const selectedCharactersBeforeSafety = validated.characters;
    let selectedFinalCollisionPairs = fitCollisionPairs(
      baselineSceneForSafety,
      [...selectedComponentsBeforeSafety, ...characterCollisionComponents(selectedCharactersBeforeSafety, selectedComponentsBeforeSafety)],
    );
    const baselineCollisionKeys = new Set(baselineCollisionsForSafety.map((pair) => [pair.firstId, pair.secondId].sort().join("\u0000")));
    const baselineById = new Map(baselineSceneForSafety.map((component) => [component.id, component]));
    const selectedMajorOverlapPairs = selectedFinalCollisionPairs.filter((pair) => {
      if (pair.classification === "allowed" || baselineCollisionKeys.has([pair.firstId, pair.secondId].sort().join("\u0000"))) return false;
      const first = baselineById.get(pair.firstId), second = baselineById.get(pair.secondId);
      return Boolean(first && second && isMajorFitObject(first) && isMajorFitObject(second));
    });
    let finalCameraInsideComponentIds = selectedCameraBeforeSafety
      ? cameraContainingGeometryIds(selectedCameraBeforeSafety.position, selectedComponentsBeforeSafety)
      : [];
    let alignmentRejected = false;
    let alignmentRollbackUnsafe = false;
    const surfaceAlignmentChangedIds = new Set(validated.components.flatMap((component) => {
      const before = componentsBeforeSurfaceAlignment.get(component.id);
      return before && (component.position.some((value, index) => Math.abs(value - before.position[index]) > 1e-4)
        || component.size.some((value, index) => Math.abs(value - before.size[index]) > 1e-4)) ? [component.id] : [];
    }));
    let alignmentReviewCollisions = selectedFinalCollisionPairs;
    let alignmentReviewInsideIds = finalCameraInsideComponentIds;
    let alignmentReviewOverlaps = alignmentReviewCollisions.filter((pair) => {
      if (pair.classification === "allowed" || baselineCollisionKeys.has([pair.firstId, pair.secondId].sort().join("\u0000"))) return false;
      const first = baselineById.get(pair.firstId), second = baselineById.get(pair.secondId);
      return Boolean(first && second && isMajorFitObject(first) && isMajorFitObject(second));
    });
    const alignmentIsOnlyCause = (alignmentReviewOverlaps.length > 0 || alignmentReviewInsideIds.length > 0)
      && alignmentReviewOverlaps.every((pair) => surfaceAlignmentChangedIds.has(pair.firstId) || surfaceAlignmentChangedIds.has(pair.secondId))
      && alignmentReviewInsideIds.every((id) => surfaceAlignmentChangedIds.has(id));
    if (alignmentIsOnlyCause) {
      let restoredComponents = [...validated.components];
      let unresolved = true;
      // Undo only the changed objects implicated in a new collision/camera
      // intrusion. Floor and wall estimates remain in the fitted coordinate
      // system unless they themselves are the sole implicated geometry.
      for (let attempt = 0; attempt < surfaceAlignmentChangedIds.size; attempt += 1) {
        const implicated = new Set<string>(alignmentReviewInsideIds);
        for (const pair of alignmentReviewOverlaps) {
          const pairIds = [pair.firstId, pair.secondId].filter((id) => surfaceAlignmentChangedIds.has(id));
          const movableIds = pairIds.filter((id) => {
            const component = restoredComponents.find((candidate) => candidate.id === id);
            return component && component.category !== "wall" && component.category !== "ground";
          });
          for (const id of movableIds.length ? movableIds : pairIds) implicated.add(id);
        }
        if (!implicated.size) break;
        restoredComponents = restoredComponents.map((component) => implicated.has(component.id)
          ? componentsBeforeSurfaceAlignment.get(component.id) ?? component
          : component);
        const restoredCharacters = characterCollisionComponents(selectedCharactersBeforeSafety, restoredComponents);
        alignmentReviewCollisions = fitCollisionPairs(baselineSceneForSafety, [...restoredComponents, ...restoredCharacters]);
        alignmentReviewInsideIds = selectedCameraBeforeSafety
          ? cameraContainingGeometryIds(selectedCameraBeforeSafety.position, restoredComponents)
          : [];
        alignmentReviewOverlaps = alignmentReviewCollisions.filter((pair) => {
          if (pair.classification === "allowed" || baselineCollisionKeys.has([pair.firstId, pair.secondId].sort().join("\u0000"))) return false;
          const first = baselineById.get(pair.firstId), second = baselineById.get(pair.secondId);
          return Boolean(first && second && isMajorFitObject(first) && isMajorFitObject(second));
        });
        if (alignmentReviewOverlaps.length === 0 && alignmentReviewInsideIds.length === 0) {
          unresolved = false;
          break;
        }
      }
      if (!unresolved) {
        validated.components = restoredComponents;
        selectedFinalCollisionPairs = alignmentReviewCollisions;
        finalCameraInsideComponentIds = alignmentReviewInsideIds;
        alignmentRejected = true;
      } else {
        alignmentRollbackUnsafe = true;
      }
    }
    const postTransformNewMajorOverlapPairs = selectedMajorOverlapPairs.slice(0, 32)
      .map(({ firstId, secondId, classification, reason, penetrationMeters }) => ({ firstId, secondId, classification: classification as "hard" | "review", reason, penetrationMeters }));
    const postTransformUnsafe = alignmentRollbackUnsafe
      || introducesMajorOverlap(selectedFinalCollisionPairs, baselineSceneForSafety, baselineCollisionsForSafety)
      || finalCameraInsideComponentIds.length > 0;
    if (postTransformUnsafe) {
      const rejectedCandidateDiagnostics = selectedCameraBeforeSafety?.fitDiagnostics;
      validated.components = baselineComponentsForSafety;
      validated.characters = baselineCharactersForSafety;
      validated.referenceCamera = baselineCameraForSafety;
      if (baselineCameraForSafety && rejectedCandidateDiagnostics) {
        validated.referenceCamera = {
          ...baselineCameraForSafety,
          fitDiagnostics: {
            ...rejectedCandidateDiagnostics,
            postTransformSafety: { newMajorOverlapPairs: postTransformNewMajorOverlapPairs, cameraInsideComponentIds: finalCameraInsideComponentIds, alignmentRejected },
            applied: false,
            qualityStatus: "unavailable",
            rejectionReason: "unsafe-collision",
            passedErrorThreshold: false,
          },
        };
      }
    }
    const finalSelectedCamera = validated.referenceCamera;
    const finalSelectedComponentById = new Map(validated.components.map((component) => [component.id, component]));
    const finalFitPairs = fitPairs.map((pair) => ({ ...pair, component: finalSelectedComponentById.get(pair.component.id) ?? pair.component }));
    const finalPairDiagnostics = finalSelectedCamera
      ? cameraFitBreakdown(finalFitPairs, finalSelectedCamera, aspect).pairs.slice(0, 10)
      : [];
    pairDiagnostics = finalPairDiagnostics;
    residualsForReview = fit.qualityStatus === "needsReview" ? dominantFitResiduals(finalFitPairs, finalPairDiagnostics) : [];
    const finalCollisionPairs = postTransformUnsafe
      ? fitCollisionPairs(baselineSceneForSafety, [...validated.components, ...characterCollisionComponents(validated.characters, validated.components)])
      : selectedFinalCollisionPairs;
    const finalCollisionCounts = summarizeFitCollisions(finalCollisionPairs);
    const finalCollisionPenetration = summarizeFitPenetration(finalCollisionPairs);
    const finalCameraOutsideGeometry = finalSelectedCamera ? !cameraInsideGeometry(finalSelectedCamera.position, validated.components) : true;
    if (validated.referenceCamera?.fitDiagnostics) {
      const previousValidity = validated.referenceCamera.fitDiagnostics.physicalValidity;
      validated.referenceCamera.fitDiagnostics = {
        ...validated.referenceCamera.fitDiagnostics,
        pairDiagnostics: finalPairDiagnostics,
        appliedProjectionError: finalSelectedCamera ? cameraFitError(finalFitPairs, finalSelectedCamera, aspect) : null,
        ...(postTransformUnsafe ? {
          applied: false,
          qualityStatus: "unavailable",
          rejectionReason: "unsafe-collision",
          passedErrorThreshold: false,
        } : {}),
        ...(postTransformUnsafe || alignmentRejected ? { postTransformSafety: {
          newMajorOverlapPairs: postTransformNewMajorOverlapPairs,
          cameraInsideComponentIds: finalCameraInsideComponentIds,
          alignmentRejected,
        } } : {}),
        ...(alignmentRejected && !postTransformUnsafe ? { qualityStatus: "needsReview" } : {}),
        physicalValidity: {
          ...(previousValidity ?? { withinRoom: false, cameraOutsideGeometry: true, hardCollisionCount: 0 }),
          cameraOutsideGeometry: finalCameraOutsideGeometry,
          hardCollisionCount: finalCollisionCounts.hard,
          finalCollisionCounts,
          finalPenetrationMeters: finalCollisionPenetration,
        },
        collisionPairs: finalCollisionPairs,
      };
    }
    const finalFitDiagnostics = validated.referenceCamera?.fitDiagnostics;
    const finalPhysicalValidity = finalFitDiagnostics?.physicalValidity ?? fit.physicalValidity;
    const collisionEvidence = `初态实际棱柱穿透深度 ${finalPhysicalValidity?.initialPenetrationMeters?.toFixed(3) ?? "未知"}m，最终 ${finalPhysicalValidity?.finalPenetrationMeters?.toFixed(3) ?? "未知"}m（另有待复核代理重叠）；不代表网格穿模结论。`;
    const hasAppliedSpatialCandidate = finalFitDiagnostics?.applied === true && fit.components.length > 0;
    const finalQuality = finalFitDiagnostics?.qualityStatus ?? fit.qualityStatus;
    const finalRejection = finalFitDiagnostics?.rejectionReason ?? fit.rejectionReason;
    const evidence = finalRejection === "insufficient-evidence"
      ? `参考机位拟合未执行：可靠主要物件不足（${fit.count}/3），保留 bounds fallback。${collisionEvidence}`
      : finalRejection === "no-safe-candidate"
        ? `参考机位没有通过安全门的空间候选：${fit.count} 个主要物件，已检验 ${fit.candidateCount} 个相机候选；位置/尺寸保持观察先验并标记待复核。${collisionEvidence}`
        : finalRejection === "unsafe-collision"
          ? `最终墙地与开口对齐后出现新的硬碰撞或相机侵入，已撤销空间候选并保留原始组件位置；最终投影与碰撞诊断按回退场景计算。${collisionEvidence}`
          : alignmentRejected
            ? `墙/地面/挂接件的低置信对齐会引入新代理重叠，已仅撤回该对齐组；安全的地面布局与机位保留，质量待复核。${collisionEvidence}`
          : finalQuality === "needsReview"
            ? `参考机位单图估算候选待人工复核：${fit.count} 个主要物件，候选投影框误差 ${fit.before?.toFixed(3) ?? "不可用"}→${fit.best?.toFixed(3) ?? "不可用"}，最终场景误差 ${finalFitDiagnostics?.appliedProjectionError?.toFixed(3) ?? "不可用"}；数值门槛不代表视觉验收。${collisionEvidence}主要偏差：${residualsForReview.map(({ pair, diagnostic }) => `${pair.component.name}（中心 ${diagnostic.centerError.toFixed(2)}、尺度 ${diagnostic.scaleError.toFixed(2)}）`).join("、")}；${hasAppliedSpatialCandidate ? "已生成位置/尺寸空间估算候选，仍需人工确认。" : "物件位置与尺寸保持观察先验，仍需人工确认。"}`
            : finalQuality === "accepted" && hasAppliedSpatialCandidate
              ? `参考机位候选通过数值约束并应用；候选误差 ${fit.best?.toFixed(3) ?? "不可用"}，最终场景误差 ${finalFitDiagnostics?.appliedProjectionError?.toFixed(3) ?? "不可用"}。单图空间关系仍需人工确认。${collisionEvidence}`
              : `参考机位候选未应用（${finalRejection ?? "未通过质量检查"}）：${fit.count} 个主要物件，候选误差 ${fit.before?.toFixed(3) ?? "不可用"}→${fit.best?.toFixed(3) ?? "不可用"}；保留安全的原始组件位置。${collisionEvidence}`;
    validated.observations = [...(validated.observations ?? []).slice(0, 11), { state: "ambiguous", confidence: fit.camera?.confidence ?? 0, evidence }];
  }
  return validated;
}
