import type { DirectorLayoutCategory } from "./directorProject";
import {
  validateLayoutDraftCandidate,
  type LayoutDraftComponent,
  type LayoutDraftCharacter,
  type LayoutDraft,
  type LayoutDraftSource,
  type LayoutSpaceType,
} from "./layoutDraft";
import { resolveLayoutSemanticProfile } from "./layoutSemanticProfiles";

/** Canonical image basis: camera at +Z looking toward -Z; image right is +X. */
export type ImageSurfaceSide = "image_left" | "image_right" | "image_back" | "floor" | "unknown";
export type ImageVisibility = "visible" | "partly_occluded" | "occluded" | "uncertain";
export type NormalizedImageBox = [left: number, top: number, right: number, bottom: number];
export type ContactWallSide = "image_left" | "image_right" | "image_back" | "unknown" | "none";
export type ImageScreenDirection = "image_left" | "image_right" | "image_up" | "image_down" | "unknown";
export type ImageFacingDirection = "image_left" | "image_right" | "toward_camera" | "away_from_camera" | "unknown";

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
  curtain: "window",
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
      ? base.raw.semanticType.trim().slice(0, 48).replace(/[^a-zA-Z0-9_-]/g, "_") || undefined
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
    surfaces,
    items,
    ...(people.length ? { people } : {}),
  };
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
  if (item.category) return item.category;
  const semantic = (item.semanticType ?? "").toLowerCase();
  const profile = resolveLayoutSemanticProfile(semantic, item.name);
  if (profile) return profile.category;
  const known = SEMANTIC_CATEGORY[semantic];
  if (known) return known;
  return "prop";
}

function dimensionsFor(item: ImageObservationItem, sourceAspectRatio: number): [number, number, number] {
  const profile = resolveLayoutSemanticProfile(item.semanticType, item.name);
  const preset = profile?.canonicalType === "table" ? undefined : SEMANTIC_SIZE[profile?.canonicalType ?? item.semanticType ?? ""];
  if (preset) return [...preset];
  const screenHeight = item.bbox[3] - item.bbox[1];
  const screenWidth = (item.bbox[2] - item.bbox[0]) * sourceAspectRatio;
  const width = clamp(screenWidth * METERS_PER_IMAGE_EXTENT, 0.25, 3.5);
  const category = categoryFor(item);
  const semantic = (item.semanticType ?? "").toLowerCase();
  const descriptor = `${semantic} ${item.name}`;
  const flat = isFlatDecorationSemantic(descriptor);
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
  if (UPRIGHT_SEMANTIC_PATTERN.test(descriptor)) {
    const canonicalType = profile?.canonicalType ?? semantic;
    const semanticHeight = UPRIGHT_SEMANTIC_HEIGHT_METERS[canonicalType];
    const height = semanticHeight ?? clamp(estimatedHeight, 0.5, ROOM_HEIGHT_METERS);
    const widthFromImageRatio = clamp(height * screenWidth / Math.max(0.01, screenHeight), 0.25, 3.5);
    return [widthFromImageRatio, height, clamp(height * 0.25, 0.25, 0.8)];
  }
  const heightByCategory: Partial<Record<DirectorLayoutCategory, number>> = {
    ground: 0.03, table: 0.75, chair: 0.9, sofa: 0.8, cabinet: 1.2, door: 2.05, window: 1.5, pillar: ROOM_HEIGHT_METERS, prop: 0.5,
  };
  if (profile?.canonicalType === "table") return [width, 0.75, 0.7];
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
}

export function cameraWorldCorners(component: LayoutDraftComponent) {
  const radians = component.rotationYDegrees * Math.PI / 180;
  const centerY = component.position[1] + component.size[1] / 2;
  return [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => {
    const localX = sx * component.size[0] / 2;
    const localZ = sz * component.size[2] / 2;
    return [
      component.position[0] + Math.cos(radians) * localX + Math.sin(radians) * localZ,
      centerY + sy * component.size[1] / 2,
      component.position[2] - Math.sin(radians) * localX + Math.cos(radians) * localZ,
    ] as const;
  })));
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
    weightedContribution: number;
  }> = [];
  for (const pair of pairs) {
    const projected = cameraWorldCorners(pair.component).map((corner) => {
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
      weightedContribution: contribution,
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

type FitCamera = { position: [number, number, number]; target: [number, number, number]; fov: number };

function cameraCandidates(pairs: readonly CameraFitPair[], allComponents: readonly LayoutDraftComponent[], aspect: number): FitCamera[] {
  const corners = pairs.flatMap(({ component }) => cameraWorldCorners(component));
  if (!corners.length) return [];
  const min = [0, 1, 2].map((axis) => Math.min(...corners.map((point) => point[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...corners.map((point) => point[axis])));
  const distanceBase = Math.max(1, ...[0, 1, 2].map((axis) => max[axis] - min[axis]));
  const candidates: FitCamera[] = [];
  for (const azimuthDegrees of [-35, -20, 0, 20, 35]) {
    for (const distanceFactor of [0.6, 0.85, 1.1, 1.5]) {
      for (const pitchDegrees of [-5, 0, 5, 10, 15]) {
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
  const starts = candidates
    .map((camera) => ({ camera, error: cameraFitError(pairs, camera, aspect) }))
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

function introducesMajorOverlap(collisions: readonly FitCollisionPair[], original: readonly LayoutDraftComponent[]) {
  const byId = new Map(original.map((component) => [component.id, component]));
  return collisions.some((collision) => {
    if (collision.classification === "allowed") return false;
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
      const next = fittedChild ?? {
        ...child,
        position: child.position.map((value, index) => value + delta[index]) as [number, number, number],
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

function overlapsForFit(a: LayoutDraftComponent, b: LayoutDraftComponent) {
  if (a.category === "ground" || b.category === "ground" || a.category === "wall" || b.category === "wall") return false;
  const vertical = Math.min(a.position[1] + a.size[1], b.position[1] + b.size[1]) - Math.max(a.position[1], b.position[1]);
  if (vertical <= 0.02) return false;
  const extent = (component: LayoutDraftComponent) => {
    const yaw = component.rotationYDegrees * Math.PI / 180;
    return {
      x: (Math.abs(Math.cos(yaw)) * component.size[0] + Math.abs(Math.sin(yaw)) * component.size[2]) / 2,
      z: (Math.abs(Math.sin(yaw)) * component.size[0] + Math.abs(Math.cos(yaw)) * component.size[2]) / 2,
    };
  };
  const ea = extent(a), eb = extent(b);
  return Math.abs(a.position[0] - b.position[0]) < ea.x + eb.x - 0.02
    && Math.abs(a.position[2] - b.position[2]) < ea.z + eb.z - 0.02;
}

type FitCollisionPair = { firstId: string; secondId: string; classification: "hard" | "review" | "allowed"; reason: string };

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

function isFlatDecoration(component: LayoutDraftComponent) {
  return component.size[1] <= 0.12
    || isFlatDecorationSemantic(`${component.semanticType ?? ""} ${component.name}`);
}

function fitCollisionPairs(allComponents: readonly LayoutDraftComponent[], fittedComponents: readonly LayoutDraftComponent[]): FitCollisionPair[] {
  const fittedById = new Map(fittedComponents.map((component) => [component.id, component]));
  const originalById = new Map(allComponents.map((component) => [component.id, component]));
  const reports: FitCollisionPair[] = [];
  for (let left = 0; left < allComponents.length; left += 1) {
    const originalA = allComponents[left];
    const nextA = fittedById.get(originalA.id) ?? originalA;
    for (let right = left + 1; right < allComponents.length; right += 1) {
      const originalB = allComponents[right];
      const nextB = fittedById.get(originalB.id) ?? originalB;
      if (overlapsForFit(originalA, originalB) || !overlapsForFit(nextA, nextB)) continue;
      if (hasAncestorRelation(originalA, originalB, originalById)
        || originalA.supportComponentId === originalB.id || originalB.supportComponentId === originalA.id
        || originalA.partOfComponentId === originalB.id || originalB.partOfComponentId === originalA.id) {
        reports.push({ firstId: originalA.id, secondId: originalB.id, classification: "allowed", reason: "parent-child-or-descendant-overlap" });
        continue;
      }
      const flatDecorationOverlap = isFlatDecoration(originalA) || isFlatDecoration(originalB);
      const yawExtent = (component: LayoutDraftComponent) => {
        const yaw = component.rotationYDegrees * Math.PI / 180;
        return {
          x: (Math.abs(Math.cos(yaw)) * component.size[0] + Math.abs(Math.sin(yaw)) * component.size[2]) / 2,
          z: (Math.abs(Math.sin(yaw)) * component.size[0] + Math.abs(Math.cos(yaw)) * component.size[2]) / 2,
        };
      };
      const ea = yawExtent(nextA), eb = yawExtent(nextB);
      const overlapX = Math.max(0, ea.x + eb.x - Math.abs(nextA.position[0] - nextB.position[0]));
      const overlapZ = Math.max(0, ea.z + eb.z - Math.abs(nextA.position[2] - nextB.position[2]));
      const overlapY = Math.max(0, Math.min(nextA.position[1] + nextA.size[1], nextB.position[1] + nextB.size[1]) - Math.max(nextA.position[1], nextB.position[1]));
      const smallerVolume = Math.min(nextA.size[0] * nextA.size[1] * nextA.size[2], nextB.size[0] * nextB.size[1] * nextB.size[2]);
      const overlapRatio = smallerVolume > 0 ? overlapX * overlapY * overlapZ / smallerVolume : 0;
      const clearPenetration = overlapRatio >= 0.7
        && overlapX >= Math.min(nextA.size[0], nextB.size[0]) * 0.6
        && overlapY >= Math.min(nextA.size[1], nextB.size[1]) * 0.6
        && overlapZ >= Math.min(nextA.size[2], nextB.size[2]) * 0.6;
      const newMajorOverlap = isMajorFitObject(originalA) && isMajorFitObject(originalB);
      reports.push({
        firstId: originalA.id,
        secondId: originalB.id,
        classification: clearPenetration || newMajorOverlap ? "hard" : flatDecorationOverlap && overlapRatio < 0.7 ? "allowed" : "review",
        reason: clearPenetration ? "large-volume-penetration" : newMajorOverlap ? "new-major-object-overlap" : flatDecorationOverlap && overlapRatio < 0.7 ? "minor-flat-decoration-overlap" : "coarse-aabb-overlap-requires-review",
      });
    }
  }
  return reports.slice(0, 32);
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

/** Fits only the camera against observed object bounds. Scene geometry and explicit
 * support/partOf relationships remain fixed; a high residual stays under review. */
export function fitReferenceScene(pairs: readonly CameraFitPair[], fallback: LayoutDraft["referenceCamera"], aspect: number, allComponents: readonly LayoutDraftComponent[], characters: readonly LayoutDraftCharacter[] = []) {
  if (pairs.length < 3 || !fallback) return { camera: fallback, before: undefined, best: undefined, bestCandidate: undefined, cameraOnlyBest: undefined, count: pairs.length, candidateCount: 0, rejectionReason: "insufficient-evidence" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: 0, collisionPairs: [] as FitCollisionPair[], physicalValidity: undefined, passedErrorThreshold: undefined };
  const floor = allComponents.find((component) => component.category === "ground");
  const roomBounds = floor
    ? (() => {
      return { minX: floor.position[0] - floor.size[0] / 2, maxX: floor.position[0] + floor.size[0] / 2, minZ: floor.position[2] - floor.size[2] / 2, maxZ: floor.position[2] + floor.size[2] / 2 };
    })()
    : { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };
  const before = cameraFitError(pairs, fallback, aspect);
  let best: { camera: FitCamera; error: number; rawError: number; components: LayoutDraftComponent[]; movement: number } | undefined;
  let bestCameraOnly: { camera: FitCamera; rawError: number } | undefined;
  const candidates = cameraCandidates(pairs, allComponents, aspect);
  for (const camera of candidates) {
    const characterOriginal = characterCollisionComponents(characters, allComponents);
    const options = [pairs.map((pair) => ({ error: 0, component: pair.component, movement: 0 }))];
    for (const option of options) {
      const fittedRoots = option.map((entry) => entry.component);
      if (!observedHorizontalOrderIsPreserved(pairs, fittedRoots, camera)) continue;
      const nextPairs = pairs.map((pair, index) => ({ ...pair, component: fittedRoots[index] }));
      const rawError = cameraFitError(nextPairs, camera, aspect);
      const carriedCandidate = carryFittedParentMotion(fittedRoots, allComponents);
      const characterFitted = characterCollisionComponents(characters, carriedCandidate.components);
      const candidateCollisions = fitCollisionPairs([...allComponents, ...characterOriginal], [...carriedCandidate.components, ...characterFitted]);
      if (candidateCollisions.some((collision) => collision.classification === "hard")
        || introducesMajorOverlap(candidateCollisions, [...allComponents, ...characterOriginal])) continue;
      if (!bestCameraOnly || rawError < bestCameraOnly.rawError) bestCameraOnly = { camera, rawError };
      const movement = option.reduce((sum, entry) => sum + entry.movement, 0) / option.length;
      const score = rawError + 0.08 * movement;
      if (!best || score < best.error) best = { camera, error: score, rawError, components: fittedRoots, movement };
    }
  }
  if (!best || !Number.isFinite(best.rawError)) return { camera: fallback, before, best: undefined, bestCandidate: undefined, cameraOnlyBest: bestCameraOnly?.rawError, count: pairs.length, candidateCount: candidates.length, rejectionReason: "no-safe-candidate" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: 0, collisionPairs: [] as FitCollisionPair[], physicalValidity: undefined, passedErrorThreshold: undefined };
  // Once camera-only fitting meets the same acceptance threshold, keep every
  // observed object and its support/partOf relationships fixed.
  if (bestCameraOnly && bestCameraOnly.rawError <= 0.22) {
    best = { camera: bestCameraOnly.camera, error: bestCameraOnly.rawError, rawError: bestCameraOnly.rawError, components: pairs.map(({ component }) => component), movement: 0 };
  }
  const bestCandidate = { position: best.camera.position, target: best.camera.target, fov: best.camera.fov };
  const movedCount = best.components.filter((component, index) => {
    const original = pairs[index].component.position;
    return Math.hypot(component.position[0] - original[0], component.position[2] - original[2]) > 0.05;
  }).length;
  if (best.rawError >= before * 0.9) return { camera: fallback, before, best: best.rawError, bestCandidate, cameraOnlyBest: bestCameraOnly?.rawError, count: pairs.length, candidateCount: candidates.length, rejectionReason: "insufficient-improvement" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: best.movement, collisionPairs: [] as FitCollisionPair[], physicalValidity: undefined, passedErrorThreshold: undefined };
  const carried = carryFittedParentMotion(best.components, allComponents);
  const roomBoundaryViolations = !floor ? [] : carried.components.flatMap((component) => {
    if (["ground", "wall", "door", "window"].includes(component.category)) return [];
    const yaw = component.rotationYDegrees * Math.PI / 180;
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
  const withinRoom = roomBoundaryViolations.length === 0;
  const characterOriginal = characterCollisionComponents(characters, allComponents);
  const characterFitted = characterCollisionComponents(characters, carried.components);
  const collisionPairs = fitCollisionPairs([...allComponents, ...characterOriginal], [...carried.components, ...characterFitted]);
  const hardCollisionCount = collisionPairs.filter((pair) => pair.classification === "hard").length;
  const cameraOutsideGeometry = !cameraInsideGeometry(best.camera.position, carried.components);
  if (!cameraOutsideGeometry || hardCollisionCount > 0) {
    return { camera: fallback, before, best: best.rawError, bestCandidate, cameraOnlyBest: bestCameraOnly?.rawError, count: pairs.length, candidateCount: candidates.length, rejectionReason: hardCollisionCount ? "unsafe-collision" as const : "no-safe-candidate" as const, qualityStatus: "unavailable" as const, components: [] as LayoutDraftComponent[], movedCount: 0, movedComponentCount: 0, movement: best.movement, collisionPairs, physicalValidity: { withinRoom, cameraOutsideGeometry, hardCollisionCount, roomBoundaryViolations } };
  }
  if (best.rawError > 0.22) return {
    camera: { ...best.camera, projection: "perspective" as const, confidence: fallback.confidence, source: "estimated" as const, imageAspectRatio: aspect },
    before, best: best.rawError, bestCandidate, count: pairs.length, candidateCount: candidates.length,
    rejectionReason: "error-too-high" as const, qualityStatus: "needsReview" as const,
    cameraOnlyBest: bestCameraOnly?.rawError,
    components: carried.components.filter((component) => {
      const original = allComponents.find((candidate) => candidate.id === component.id);
      return original && (component.position.some((value, index) => Math.abs(value - original.position[index]) > 1e-4));
    }), movedCount, movedComponentCount: carried.movedComponentCount, movement: best.movement, collisionPairs, physicalValidity: { withinRoom, cameraOutsideGeometry, hardCollisionCount, roomBoundaryViolations }, passedErrorThreshold: false,
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
    components: carried.components.filter((component) => {
      const original = allComponents.find((candidate) => candidate.id === component.id);
      return original && component.position.some((value, index) => Math.abs(value - original.position[index]) > 1e-4);
    }),
    movedCount,
    movedComponentCount: carried.movedComponentCount,
    movement: best.movement,
    collisionPairs,
    physicalValidity: { withinRoom, cameraOutsideGeometry, hardCollisionCount, roomBoundaryViolations },
    passedErrorThreshold: true,
  };
}

function cameraInsideGeometry(position: [number, number, number], components: readonly LayoutDraftComponent[]) {
  return components.some((component) => {
    if (component.category === "ground") return false;
    const radians = component.rotationYDegrees * Math.PI / 180;
    const dx = position[0] - component.position[0];
    const dz = position[2] - component.position[2];
    const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
    const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
    return Math.abs(localX) < component.size[0] / 2
      && Math.abs(localZ) < component.size[2] / 2
      && position[1] > component.position[1]
      && position[1] < component.position[1] + component.size[1];
  });
}

export function fitReferenceCamera(pairs: readonly CameraFitPair[], fallback: LayoutDraft["referenceCamera"], aspect: number, allComponents: readonly LayoutDraftComponent[]) {
  if (pairs.length < 3 || !fallback) return { camera: fallback, before: undefined, best: undefined, bestCandidate: undefined, count: pairs.length, candidateCount: 0, rejectionReason: "insufficient-evidence" as const };
  const before = cameraFitError(pairs, fallback, aspect);
  let best: { camera: { position: [number, number, number]; target: [number, number, number]; fov: number }; error: number } | undefined;
  const candidates = cameraCandidates(pairs, allComponents, aspect);
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

function presetCoversPart(parent: ImageObservationItem, child: ImageObservationItem) {
  if (partOfChainHasCycle(child, new Map([[parent.id, parent], [child.id, child]]))) return false;
  const childType = (child.semanticType ?? "").toLowerCase();
  const childName = child.name.toLowerCase();
  const isNamed = (...terms: string[]) => terms.some((term) => childType.includes(term) || childName.includes(term));
  if (parent.semanticType === "bed") return isNamed("headboard", "床头板", "mattress", "床垫", "pillow", "枕", "bed_frame", "床架");
  if (parent.semanticType === "curtain") return isNamed("curtain_panel", "窗帘布", "纱帘", "帘布");
  if (parent.semanticType === "bookshelf") return isNamed("shelf", "层板", "侧板", "书架板");
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
  surface: ImageObservationSurface | undefined,
  surfaceConflict: boolean,
  spaceType: LayoutSpaceType,
  support: { position: [number, number, number]; size: [number, number, number]; rotationYDegrees: number; category: DirectorLayoutCategory } | undefined,
  rearAnchorSurface?: ImageObservationSurface,
  floorSurface?: ImageObservationSurface,
): { position: [number, number, number]; yaw: number; uncertain: boolean; supportAdjusted: boolean; supportTooSmall: boolean } {
  const [cx, cy] = center(item.bbox);
  const isFloorPlaced = !support || support.category === "ground";
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

  if (isFloorPlaced) {
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

  let supportAdjusted = false;
  let supportTooSmall = false;
  if (support && support.category !== "ground") {
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
    return Boolean(parent && !parent.partOfId && item.partOfId !== item.id && presetCoversPart(parent, item));
  }).map((item) => item.id));
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
        position: [0, 0, 0], size: [ROOM_WIDTH_METERS, 0.02, ROOM_DEPTH_METERS], rotationYDegrees: 0,
        confidence: surface.confidence, uncertain: floorBoundaryCropped || surface.confidence < 0.65 || !isVisible(surface.visibility ?? "visible"),
        visible: (surface.visibility ?? "visible") !== "occluded", ...(surface.mainColor ? { appearance: { color: surface.mainColor } } : {}),
        notes: floorBoundaryCropped ? `${BOX_NOTE}地面触及图像边界，房间范围为估算值，需人工复核。` : BOX_NOTE,
      });
      generated.set(surface.id, { position: [0, 0, 0], size: [ROOM_WIDTH_METERS, 0.02, ROOM_DEPTH_METERS], rotationYDegrees: 0, category: "ground" });
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
      const supportReady = !item.supportId || generated.has(item.supportId) || !itemById.has(item.supportId) || supportChainHasCycle(item, itemById);
      const parentReady = !item.partOfId || generated.has(item.partOfId) || !itemById.has(item.partOfId) || item.partOfId === item.id;
      return supportReady && parentReady;
    });
    const [item] = pendingItems.splice(readyIndex < 0 ? 0 : readyIndex, 1);
    const category = categoryFor(item);
    const size = dimensionsFor(item, observation.imageAspectRatio ?? options.imageAspectRatio ?? 1);
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
    const support = item.supportId && !supportCycle ? generated.get(item.supportId) : undefined;
    const rearAnchor = rearAnchorByParent.get(item.id);
    const resolved = itemPosition(item, size, category, rearAnchor?.conflict ? undefined : surface, surfaceConflict, observation.spaceType ?? "unknown", support,
      rearAnchor && !rearAnchor.conflict ? rearAnchor.surface : undefined,
      observation.surfaces.find((candidate) => candidate.kind === "floor"));
    const position = resolved.position;
    const yaw = resolved.yaw;
    const semanticType = item.semanticType;
    const observedWidth = (item.bbox[2] - item.bbox[0]) * (observation.imageAspectRatio ?? options.imageAspectRatio ?? 1);
    const observedHeight = item.bbox[3] - item.bbox[1];
    const ambiguousWideProp = category === "prop" && observedWidth >= observedHeight * 1.8 && !isFlatDecorationSemantic(`${semanticType ?? ""} ${item.name}`);
    const uncertain = resolved.uncertain
      || Boolean(item.supportId && !support)
      || Boolean(item.partOfId && (item.partOfId === item.id || !itemById.has(item.partOfId) || !skippedParts.has(item.id)))
      || Boolean(rearAnchor?.conflict)
      || Boolean(rearAnchor && surface && surface.id !== rearAnchor.surface.id)
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
      item.partOfId && parent ? `图像子部件归入 ${parent.name}，不重复创建独立几何。` : "",
      item.partOfId && (!parent || !skippedParts.has(item.id)) ? "子部件未能确认已被父组件几何覆盖，保留独立几何并待确认。" : "",
      ambiguousWideProp ? "宽扁外观缺少明确形体语义（可能是屏幕、横幅或家具）；未按宽高比推断水平承载方向，尺寸待确认。" : "",
    ].filter(Boolean).join(" ");
    components.push({
      id: item.id, name: item.name, category, primitive: category === "pillar" ? "cylinder" : "box",
      position, size, rotationYDegrees: yaw, confidence: item.confidence,
      uncertain: uncertain || item.visibility !== "visible", visible: item.visibility !== "occluded",
      ...(semanticType ? { semanticType } : {}),
      ...(item.mainColor || (surface?.kind === "wall" && isOpening(category))
        ? { appearance: { ...(item.mainColor ? { color: item.mainColor } : {}), ...(surface?.kind === "wall" && isOpening(category) ? { frontDirectionDegrees: yaw } : {}) } }
        : {}),
      ...(support ? { supportComponentId: item.supportId } : {}),
      ...(item.partOfId && generated.has(item.partOfId) ? { partOfComponentId: item.partOfId } : {}),
      notes,
    });
    generated.set(item.id, { position, size, rotationYDegrees: yaw, category });
    observations.push({ componentId: item.id, state: observationState(item.visibility), confidence: item.confidence, evidence: notes });
    const relationSurface = rearAnchor && !rearAnchor.conflict ? rearAnchor.surface : surface;
    if (relationSurface && generated.has(relationSurface.id)) {
      const usesLegacyBedHead = semanticType === "bed" && !item.contactWallSide && Boolean(item.againstSurfaceId);
      relations.push({ fromId: item.id, toId: relationSurface.id, type: semanticType === "bed" && (rearAnchor && !rearAnchor.conflict || usesLegacyBedHead) ? "head_at" : isOpening(category) ? "attached_to" : "adjacent_to", confidence: Math.min(item.confidence, relationSurface.confidence) });
    } else if (item.againstSurfaceId || item.contactWallSide) {
      observations.push({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, 0.5), evidence: "墙面锚点不可用，保留估算位置并待确认。" });
    }
    if (rearAnchor?.conflict) observations.push({ componentId: item.id, state: "ambiguous", confidence: Math.min(item.confidence, 0.5), evidence: "父级背面特征或延伸方向与已识别后侧子部件接墙证据冲突；未据此锚定，保留原观察待确认。" });
    if (item.supportId && generated.has(item.supportId)) {
      relations.push({ fromId: item.id, toId: item.supportId, type: "supports", confidence: item.confidence });
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
  const reliableCameraCategories: DirectorLayoutCategory[] = ["table", "chair", "sofa", "cabinet", "prop"];
  const selectedCameraItems = observation.items
    .filter((item) => item.confidence >= 0.75 && item.visibility === "visible" && !item.partOfId
      && reliableCameraCategories.includes(categoryFor(item))
      && (!item.supportId || generated.get(item.supportId)?.category === "ground")
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
    return [{ bbox: item.bbox, confidence: item.confidence, component, ...(wall?.kind === "wall" ? { surfaceSide: wall.side } : {}), onGround: !wall && (!support || support.category === "ground") }];
  });
  const aspect = observation.imageAspectRatio ?? options.imageAspectRatio;
  if (typeof aspect === "number" && Number.isFinite(aspect) && aspect >= 0.1 && aspect <= 10) {
    const fit = fitReferenceScene(fitPairs, validated.referenceCamera, aspect, validated.components, validated.characters);
    const pairDiagnostics = fit.camera ? cameraFitBreakdown(fitPairs, fit.camera, aspect).pairs.slice(0, 10) : [];
    const residualsForReview = fit.qualityStatus === "needsReview" ? dominantFitResiduals(fitPairs, pairDiagnostics) : [];
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
        collisionPairs: fit.collisionPairs,
        physicalValidity: fit.physicalValidity,
      },
    };
    if (fit.qualityStatus !== "unavailable") {
      const fittedById = new Map(fit.components.map((component) => [component.id, component]));
      validated.components = validated.components.map((component) => fittedById.get(component.id) ?? component);
    }
    if (residualsForReview.length) {
      const residualById = new Map(residualsForReview.map(({ pair, diagnostic }) => [pair.component.id, diagnostic]));
      validated.components = validated.components.map((component) => {
        const residual = residualById.get(component.id);
        if (!residual) return component;
        const note = `投影框与原图观察不一致（中心偏差 ${residual.centerError.toFixed(2)}、宽高尺度偏差 ${residual.scaleError.toFixed(2)}）；布局估算未自动改写，需复核遮挡与物件轮廓。`;
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
    const evidence = fit.best === undefined
      ? `参考机位拟合未执行：可靠主要物件不足（${fit.count}/3），保留 bounds fallback。`
      : fit.qualityStatus === "needsReview"
        ? `参考机位单图估算候选待人工复核：${fit.count} 个主要物件，投影框误差 ${fit.before!.toFixed(3)}→${fit.best!.toFixed(3)}，${fit.passedErrorThreshold ? "通过" : "未通过"} 0.22 数值门槛；这不代表视觉验收。主要偏差：${residualsForReview.map(({ pair, diagnostic }) => `${pair.component.name}（中心 ${diagnostic.centerError.toFixed(2)}、尺度 ${diagnostic.scaleError.toFixed(2)}）`).join("、")}；相关组件已标记待确认，位置与尺寸未自动改写。`
        : `参考机位候选不可安全应用（${fit.rejectionReason}）：${fit.count} 个主要物件，误差 ${fit.before?.toFixed(3) ?? "不可用"}→${fit.best?.toFixed(3) ?? "不可用"}；保留 bounds fallback。`;
    validated.observations = [...(validated.observations ?? []).slice(0, 11), { state: "ambiguous", confidence: fit.camera?.confidence ?? 0, evidence }];
  }
  return validated;
}
