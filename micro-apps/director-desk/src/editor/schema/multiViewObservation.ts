import type { ImageObservation, ImageObservationItem, ImageObservationSurface, ImageObservationPerson } from "./imageObservationLayout";
import { parseDirectorLayoutObservationV2 } from "../../../../../functions/shared/director-layout-observations.js";
import { calibrateGroundCamera } from "./referenceGroundProjection";

export interface MultiViewEntity {
  id: string;
  kind: "surface" | "item" | "person";
  name: string;
  semanticType?: string;
  category?: ImageObservationItem["category"];
  surfaceKind?: "wall" | "floor";
  placement?: "wall_attached" | "floor" | "supported" | "unknown";
  posture?: ImageObservationPerson["posture"];
  kneelVariant?: ImageObservationPerson["kneelVariant"];
  handGesture?: ImageObservationPerson["handGesture"];
  identityConfidence: number;
  uncertain: boolean;
}

export interface MultiViewPoint {
  pointId: string;
  planeId: string;
  point: [number, number];
  confidence: number;
  visibility: "visible" | "inferred";
}

export interface MultiViewObservation {
  entityId: string;
  side?: ImageObservationSurface["side"];
  bbox?: [number, number, number, number];
  confidence: number;
  visibility: ImageObservationItem["visibility"];
  mainColor?: string | null;
  groundContacts?: Array<NonNullable<ImageObservationItem["groundContacts"]>[number] & { pointId: string; planeId: string }>;
  groundFootprints?: Array<NonNullable<ImageObservationItem["groundFootprints"]>[number] & { planeId: string }>;
  occludesEntityIds?: string[];
  facingDirection?: ImageObservationPerson["facingDirection"];
  contactWallSide?: ImageObservationItem["contactWallSide"];
  bodyExtendsToward?: ImageObservationItem["bodyExtendsToward"];
  rearFeature?: ImageObservationItem["rearFeature"];
  visibleBbox?: [number, number, number, number];
  completeBbox?: [number, number, number, number];
}

export interface MultiViewFrame {
  sourceId: string;
  entities: MultiViewObservation[];
  groundLandmarks?: MultiViewPoint[];
  geometryEvidence?: ImageObservation["geometryEvidence"];
}

export interface MultiViewContract {
  contractVersion: "image-observations-v2";
  spaceType: NonNullable<ImageObservation["spaceType"]>;
  entities: MultiViewEntity[];
  views: MultiViewFrame[];
  relations: Array<{ type: "support" | "partOf" | "against" | "facing"; from: string; to: string; confidence: number }>;
}

export interface DerivedGroundPlacement {
  entityId: string;
  name: string;
  semanticType: string;
  category: NonNullable<MultiViewEntity["category"]>;
  confidence: number;
  uncertain: boolean;
  sourceId: string;
  sourceIds: string[];
  sourceBbox: [number, number, number, number];
  sourceFileName?: string;
  groundContacts: Array<{ point: [number, number]; kind: "center" | "corner" | "edge"; visibility: "visible"; confidence: number }>;
  groundFootprints: Array<NonNullable<MultiViewObservation["groundFootprints"]>[number]>;
}

export type Correspondence = { source: [number, number]; target: [number, number]; pointId: string; confidence: number };
type Homography = [number, number, number, number, number, number, number, number, number];

const validPoint = (point: unknown): point is [number, number] => Array.isArray(point) && point.length === 2
  && point.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);

function solveLinear(matrix: number[][], values: number[]) {
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let col = 0; col < rows.length; col++) {
    let pivot = col;
    for (let row = col + 1; row < rows.length; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    if (Math.abs(rows[pivot][col]) < 1e-10) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const scale = rows[col][col];
    for (let index = col; index <= rows.length; index++) rows[col][index] /= scale;
    for (let row = 0; row < rows.length; row++) if (row !== col) {
      const factor = rows[row][col];
      for (let index = col; index <= rows.length; index++) rows[row][index] -= factor * rows[col][index];
    }
  }
  return rows.map((row) => row[rows.length]);
}

function fitHomography(points: Correspondence[]): Homography | null {
  if (points.length < 4) return null;
  const matrix: number[][] = [], values: number[] = [];
  for (const { source: [x, y], target: [u, v] } of points) {
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); values.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]); values.push(v);
  }
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rhs = Array(8).fill(0);
  matrix.forEach((row, index) => {
    for (let left = 0; left < 8; left++) {
      rhs[left] += row[left] * values[index];
      for (let right = 0; right < 8; right++) normal[left][right] += row[left] * row[right];
    }
  });
  const result = solveLinear(normal, rhs);
  if (!result) return null;
  return [...result, 1] as Homography;
}

function applyHomography(point: readonly [number, number], homography: Homography): [number, number] | null {
  const [x, y] = point;
  const denominator = homography[6] * x + homography[7] * y + homography[8];
  if (Math.abs(denominator) < 1e-8) return null;
  const u = (homography[0] * x + homography[1] * y + homography[2]) / denominator;
  const v = (homography[3] * x + homography[4] * y + homography[5]) / denominator;
  return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null;
}

function combinations<T>(values: T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (values.length < count) return [];
  return values.flatMap((value, index) => combinations(values.slice(index + 1), count - 1).map((tail) => [value, ...tail]));
}

/** Fits only explicitly corresponding coplanar ground points. It never accepts object boxes or arbitrary corners. */
export function fitGroundPlaneHomography(points: Correspondence[]) {
  const unique = new Map(points.map((point) => [point.pointId, point]));
  if (unique.size !== points.length) return { registered: false as const, reason: "duplicate-point-id" as const };
  const correspondences = [...unique.values()].filter((point) => point.confidence >= 0.75).sort((a, b) => a.pointId.localeCompare(b.pointId)).slice(0, 8);
  if (correspondences.length < 5) return { registered: false as const, reason: "insufficient-correspondences" as const };
  const area = (values: Correspondence[], key: "source" | "target") => {
    const ordered = [...values].map((item) => item[key]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const lower: number[][] = [], upper: number[][] = [];
    for (const point of ordered) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop(); lower.push(point); }
    for (const point of ordered.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop(); upper.push(point); }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    return Math.abs(hull.reduce((sum, point, index) => { const next = hull[(index + 1) % hull.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0)) / 2;
  };
  if (area(correspondences, "source") < 0.01 || area(correspondences, "target") < 0.01) return { registered: false as const, reason: "degenerate-coverage" as const };
  let best: { homography: Homography; inliers: Correspondence[]; errors: number[]; sampleIds: Set<string> } | null = null;
  for (const sample of combinations(correspondences, 4)) {
    const homography = fitHomography(sample);
    if (!homography) continue;
    const projected = correspondences.map((point) => applyHomography(point.source, homography));
    const errors = projected.map((point, index) => point ? Math.hypot(point[0] - correspondences[index].target[0], point[1] - correspondences[index].target[1]) : Infinity);
    const inlierIndexes = errors.flatMap((error, index) => error <= 0.015 ? [index] : []);
    const inlierResidual = inlierIndexes.reduce((sum, index) => sum + errors[index], 0);
    const bestResidual = best?.errors.reduce((sum, error) => sum + error, 0) ?? Infinity;
    if (!best || inlierIndexes.length > best.inliers.length || (inlierIndexes.length === best.inliers.length && inlierResidual < bestResidual)) best = {
      homography,
      inliers: inlierIndexes.map((index) => correspondences[index]),
      errors: inlierIndexes.map((index) => errors[index]),
      sampleIds: new Set(sample.map((point) => point.pointId)),
    };
  }
  if (!best || best.inliers.length < 5 || best.inliers.length / correspondences.length < 0.75
    || !best.inliers.some((point) => !best!.sampleIds.has(point.pointId))) return { registered: false as const, reason: "no-stable-homography" as const };
  if (area(best.inliers, "source") < 0.01 || area(best.inliers, "target") < 0.01) return { registered: false as const, reason: "degenerate-inlier-coverage" as const };
  const sortedErrors = [...best.errors].sort((a, b) => a - b);
  const median = sortedErrors[Math.floor(sortedErrors.length / 2)];
  if (median > 0.0075 || sortedErrors[sortedErrors.length - 1] > 0.015) return { registered: false as const, reason: "reprojection-error" as const };
  const inversePairs = best.inliers.map((point) => ({ ...point, source: point.target, target: point.source }));
  const inverse = fitHomography(inversePairs);
  if (!inverse) return { registered: false as const, reason: "inverse-fit-failed" as const };
  const inverseErrors = best.inliers.map((point) => {
    const returned = applyHomography(point.target, inverse);
    return returned ? Math.hypot(returned[0] - point.source[0], returned[1] - point.source[1]) : Infinity;
  });
  if (inverseErrors.some((error) => error > 0.015)) return { registered: false as const, reason: "inverse-reprojection-error" as const };
  return { registered: true as const, homography: best.homography, inverse, inlierPointIds: best.inliers.map((point) => point.pointId), medianNormalizedCoordinateResidual: median };
}

export function assertMultiViewContract(input: unknown, expectedSourceIds: string[]): MultiViewContract {
  return parseDirectorLayoutObservationV2(JSON.stringify(input), expectedSourceIds) as MultiViewContract;
}

export function registerGroundViews(contract: MultiViewContract, canonical: MultiViewFrame) {
  const canonicalLandmarks = (canonical.groundLandmarks ?? []).filter((point) => point.visibility === "visible" && point.confidence >= 0.75);
  const canonicalPlaneIds = new Set(canonicalLandmarks.map((point) => point.planeId));
  const landmarkById = new Map(canonicalLandmarks.map((point) => [point.pointId, point]));
  return contract.views.map((view) => {
    if (view.sourceId === canonical.sourceId) return canonicalPlaneIds.size === 1
      ? { sourceId: view.sourceId, planeId: [...canonicalPlaneIds][0], registered: true as const, inlierPointIds: canonicalLandmarks.map((point) => point.pointId), medianNormalizedCoordinateResidual: 0 }
      : { sourceId: view.sourceId, registered: false as const, reason: "mixed-or-missing-floor-plane" as const };
    const sourceLandmarks = (view.groundLandmarks ?? [])
      .filter((point) => point.visibility === "visible" && point.confidence >= 0.75)
      .flatMap((point) => {
        const target = landmarkById.get(point.pointId);
        return target && target.planeId === point.planeId ? [{ point, target }] : [];
      });
    const planeIds = new Set(sourceLandmarks.map(({ point }) => point.planeId));
    if (planeIds.size !== 1) return { sourceId: view.sourceId, registered: false as const, reason: "mixed-or-missing-floor-plane" as const };
    const correspondences = sourceLandmarks.map(({ point, target }) => ({ source: point.point, target: target.point, pointId: point.pointId, confidence: Math.min(point.confidence, target.confidence) }));
    const fit = fitGroundPlaneHomography(correspondences);
    return fit.registered ? { sourceId: view.sourceId, planeId: [...planeIds][0], ...fit } : { sourceId: view.sourceId, ...fit };
  });
}

export function selectCanonicalFrame(contract: MultiViewContract, aspectRatios: Record<string, number | undefined> = {}) {
  const identityConfidence = new Map(contract.entities.map((entity) => [entity.id, entity.identityConfidence]));
  const rank = (view: MultiViewFrame) => {
    const aspect = aspectRatios[view.sourceId];
    const calibration = aspect && view.geometryEvidence ? calibrateGroundCamera(view.geometryEvidence, aspect) : undefined;
    return calibration?.status === "calibrated" ? 2 : calibration?.status === "partial" ? 1 : 0;
  };
  const score = (view: MultiViewFrame) => {
    const aspect = aspectRatios[view.sourceId];
    const calibration = aspect && view.geometryEvidence ? calibrateGroundCamera(view.geometryEvidence, aspect) : undefined;
    const calibrationRank = calibration?.status === "calibrated" ? 2 : calibration?.status === "partial" ? 1 : 0;
    const visible = view.entities.reduce((sum, entry) => sum
      + (entry.visibility === "visible" ? 1 : entry.visibility === "partly_occluded" ? 0.5 : 0)
      * entry.confidence * (identityConfidence.get(entry.entityId) ?? 0.5), 0);
    const visibleLandmarks = (view.groundLandmarks ?? []).filter((landmark) => landmark.visibility === "visible" && landmark.confidence >= 0.75).length;
    const registeredOthers = registerGroundViews(contract, view).filter((result) => result.sourceId !== view.sourceId && result.registered).length;
    return calibrationRank * 100 + registeredOthers * 10 + Math.min(visibleLandmarks, 8) * 2 + Math.min(visible, 30);
  };
  return [...contract.views].sort((a, b) => rank(b) - rank(a) || score(b) - score(a) || a.sourceId.localeCompare(b.sourceId))[0];
}

function mapRegisteredPoint(point: readonly [number, number], sourceId: string, canonicalId: string, registration: ReturnType<typeof registerGroundViews>[number]) {
  const mapped = sourceId === canonicalId ? point : registration.registered && "homography" in registration
    ? applyHomography(point, registration.homography) : null;
  return mapped && validPoint(mapped) ? mapped : null;
}

function mapRegisteredFootprint(footprint: NonNullable<MultiViewObservation["groundFootprints"]>[number], sourceId: string, canonicalId: string, registration: ReturnType<typeof registerGroundViews>[number]) {
  const loops = [footprint.outer, ...(footprint.holes ?? [])];
  const mappedLoops = loops.map((loop) => {
    const denominators = loop.map(([x, y]) => sourceId === canonicalId || !registration.registered || !("homography" in registration)
      ? 1
      : registration.homography[6] * x + registration.homography[7] * y + registration.homography[8]);
    if (denominators.some((denominator) => Math.abs(denominator) < 1e-8)
      || denominators.some((denominator) => Math.sign(denominator) !== Math.sign(denominators[0]))) return null;
    const mapped = loop.map((point) => mapRegisteredPoint(point, sourceId, canonicalId, registration));
    return mapped.every((point): point is [number, number] => Boolean(point)) ? mapped : null;
  });
  if (mappedLoops.some((loop) => !loop)) return null;
  const [outer, ...holes] = mappedLoops as [number, number][][];
  return { outer, ...(holes.length ? { holes } : {}), visibility: footprint.visibility, confidence: footprint.confidence, planeId: footprint.planeId };
}

function footprintBounds(footprints: { outer: [number, number][] }[]) {
  const points = footprints.flatMap((footprint) => footprint.outer);
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number];
}

function footprintBoundsOverlap(a: { outer: [number, number][] }[], b: { outer: [number, number][] }[]) {
  const first = footprintBounds(a), second = footprintBounds(b);
  const width = Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0]));
  const height = Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]));
  const intersection = width * height;
  const areaA = (first[2] - first[0]) * (first[3] - first[1]);
  const areaB = (second[2] - second[0]) * (second[3] - second[1]);
  return intersection / Math.max(1e-8, areaA + areaB - intersection);
}

export function multiViewToCanonicalObservation(contract: MultiViewContract, canonical: MultiViewFrame): ImageObservation {
  const entityById = new Map(contract.entities.map((entity) => [entity.id, entity]));
  const relationships = new Map<string, Record<string, string>>();
  const relationField = { support: "supportId", partOf: "partOfId", against: "againstSurfaceId", facing: "facingTowardId" } as const;
  const relationReviewEntityIds = new Set<string>();
  const geometryReviewEntityIds = new Set<string>();
  const derivedGroundPlacements: DerivedGroundPlacement[] = [];
  const canonicalEntityIds = new Set(canonical.entities.map((row) => row.entityId));
  const againstTargets = new Map<string, string[]>();
  for (const relation of contract.relations) {
    if (relation.type === "against") {
      const targets = againstTargets.get(relation.from) ?? [];
      targets.push(relation.to);
      againstTargets.set(relation.from, targets);
      continue;
    }
    relationships.set(relation.from, { ...(relationships.get(relation.from) ?? {}), [relationField[relation.type]]: relation.to });
  }
  for (const [entityId, targets] of againstTargets) {
    if (targets.length === 1) relationships.set(entityId, { ...(relationships.get(entityId) ?? {}), againstSurfaceId: targets[0] });
    else relationReviewEntityIds.add(entityId);
  }
  const registrations = new Map(registerGroundViews(contract, canonical).map((registration) => [registration.sourceId, registration]));
  const partOfEntityIds = new Set(contract.relations.filter((relation) => relation.type === "partOf").map((relation) => relation.from));
  for (const entity of contract.entities) {
    if (entity.kind !== "item" || entity.placement !== "floor" || canonicalEntityIds.has(entity.id) || partOfEntityIds.has(entity.id)) continue;
    const candidates: DerivedGroundPlacement[] = [];
    for (const view of contract.views) {
      if (view.sourceId === canonical.sourceId) continue;
      const entry = view.entities.find((row) => row.entityId === entity.id);
      const registration = registrations.get(view.sourceId);
      if (!entry || !registration?.registered || !("planeId" in registration) || entry.visibility !== "visible" || entry.confidence < 0.75) continue;
      const groundContacts = (entry.groundContacts ?? []).filter((contact) => contact.planeId === registration.planeId
        && contact.visibility === "visible" && contact.confidence >= 0.75)
        .flatMap((contact) => {
          const point = mapRegisteredPoint(contact.point, view.sourceId, canonical.sourceId, registration);
          return point ? [{ point, kind: contact.kind, visibility: "visible" as const, confidence: contact.confidence }] : [];
        });
      const groundFootprints = (entry.groundFootprints ?? []).filter((footprint) => footprint.planeId === registration.planeId
        && footprint.visibility === "visible" && footprint.confidence >= 0.75)
        .map((footprint) => mapRegisteredFootprint(footprint, view.sourceId, canonical.sourceId, registration))
        .filter((footprint): footprint is NonNullable<MultiViewObservation["groundFootprints"]>[number] => Boolean(footprint));
      if (!groundFootprints.length && !groundContacts.some((contact) => contact.kind === "center")
        && groundContacts.filter((contact) => contact.kind !== "center").length < 2) continue;
      candidates.push({ entityId: entity.id, name: entity.name, semanticType: entity.semanticType!, category: entity.category!,
        confidence: Math.min(entity.identityConfidence, entry.confidence, ...groundFootprints.map((footprint) => footprint.confidence), ...groundContacts.map((contact) => contact.confidence)),
        uncertain: entity.uncertain, sourceId: view.sourceId, sourceIds: [view.sourceId], sourceBbox: entry.visibleBbox ?? entry.bbox!, groundContacts, groundFootprints });
    }
    const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence || a.sourceId.localeCompare(b.sourceId));
    if (ranked.length > 1) {
      const reference = ranked[0];
      const conflict = ranked.slice(1).some((candidate) => {
        if (reference.groundFootprints.length && candidate.groundFootprints.length)
          return footprintBoundsOverlap(reference.groundFootprints, candidate.groundFootprints) < 0.35;
        const first = reference.groundContacts.find((contact) => contact.kind === "center");
        const second = candidate.groundContacts.find((contact) => contact.kind === "center");
        return Boolean(first && second && Math.hypot(first.point[0] - second.point[0], first.point[1] - second.point[1]) > 0.03);
      });
      if (conflict) geometryReviewEntityIds.add(entity.id);
      else derivedGroundPlacements.push({ ...reference, uncertain: reference.uncertain || ranked.length > 1 });
    } else if (ranked.length === 1) derivedGroundPlacements.push(ranked[0]);
  }
  const sourceIdsByEntity: Record<string, string[]> = {};
  const rows = canonical.entities;
  const surfaces = rows.filter((row) => entityById.get(row.entityId)?.kind === "surface").map((row) => ({
    id: row.entityId, kind: entityById.get(row.entityId)?.surfaceKind ?? "wall", side: row.side ?? "unknown" as const,
    bbox: row.bbox!, confidence: row.confidence, visibility: row.visibility, mainColor: row.mainColor,
  } satisfies ImageObservationSurface));
  const items = rows.filter((row) => entityById.get(row.entityId)?.kind === "item").map((row) => {
    const entity = entityById.get(row.entityId)!;
    const groundContactsByPoint = new Map<string, Array<{ point: [number, number]; kind: "center" | "corner" | "edge"; visibility: "visible" | "inferred"; confidence: number; sourceId: string }>>();
    for (const view of contract.views) {
      const viewEntry = view.entities.find((candidate) => candidate.entityId === row.entityId);
      const registration = registrations.get(view.sourceId);
      if (!viewEntry || !registration) continue;
      const relationFloorId = contract.relations.find((relation) => relation.type === "support" && relation.from === row.entityId
        && entityById.get(relation.to)?.kind === "surface" && entityById.get(relation.to)?.surfaceKind === "floor")?.to;
      for (const contact of viewEntry.groundContacts ?? []) {
        const isFloorPlacement = entity.placement === "floor" || relationFloorId === contact.planeId;
        const isRegisteredPlane = view.sourceId === canonical.sourceId || (registration.registered && "planeId" in registration && registration.planeId === contact.planeId);
        if (!isFloorPlacement || !isRegisteredPlane || contact.visibility !== "visible" || contact.confidence < 0.75) continue;
        const point = mapRegisteredPoint(contact.point, view.sourceId, canonical.sourceId, registration);
        if (!point) continue;
        const values = groundContactsByPoint.get(contact.pointId) ?? [];
        values.push({ point, kind: contact.kind, visibility: contact.visibility, confidence: contact.confidence, sourceId: view.sourceId });
        groundContactsByPoint.set(contact.pointId, values);
      }
    }
    const fusedContactCandidates: Array<{ contact: NonNullable<ImageObservationItem["groundContacts"]>[number]; sourceIds: string[] }> = [];
    const evidenceSourceIds = new Set<string>();
    for (const values of groundContactsByPoint.values()) {
      const consistent = values.every((first) => values.every((second) => Math.hypot(first.point[0] - second.point[0], first.point[1] - second.point[1]) <= 0.015));
      const consistentKind = values.every((value) => value.kind === values[0].kind);
      const canonicalValues = values.filter((value) => value.sourceId === canonical.sourceId);
      if (!consistent || !consistentKind) geometryReviewEntityIds.add(row.entityId);
      if ((!consistent || !consistentKind) && !canonicalValues.length) continue;
      const selected = consistent && consistentKind ? values : canonicalValues;
      const weight = selected.reduce((sum, value) => sum + value.confidence, 0);
      const point: [number, number] = [
        selected.reduce((sum, value) => sum + value.point[0] * value.confidence, 0) / weight,
        selected.reduce((sum, value) => sum + value.point[1] * value.confidence, 0) / weight,
      ];
      fusedContactCandidates.push({
        contact: { point, kind: selected[0].kind, visibility: "visible", confidence: Math.min(...selected.map((value) => value.confidence)) },
        sourceIds: [...new Set(selected.map((value) => value.sourceId))],
      });
    }
    fusedContactCandidates.sort((a, b) => b.contact.confidence - a.contact.confidence || a.contact.point[0] - b.contact.point[0]
      || a.contact.point[1] - b.contact.point[1] || a.contact.kind.localeCompare(b.contact.kind));
    fusedContactCandidates.splice(6);
    for (const candidate of fusedContactCandidates) candidate.sourceIds.forEach((sourceId) => evidenceSourceIds.add(sourceId));
    const fusedContacts = fusedContactCandidates.map((candidate) => candidate.contact);
    const footprints: Array<{ sourceId: string; parts: NonNullable<MultiViewObservation["groundFootprints"]>; confidence: number }> = [];
    for (const view of contract.views) {
      const viewEntry = view.entities.find((candidate) => candidate.entityId === row.entityId);
      const registration = registrations.get(view.sourceId);
      if (!viewEntry || !registration) continue;
      const candidates = (viewEntry.groundFootprints ?? []).filter((footprint) => {
        const relationFloorId = contract.relations.find((relation) => relation.type === "support" && relation.from === row.entityId
          && entityById.get(relation.to)?.kind === "surface" && entityById.get(relation.to)?.surfaceKind === "floor")?.to;
        const isFloorPlacement = entity.placement === "floor" || relationFloorId === footprint.planeId;
        const isRegisteredPlane = view.sourceId === canonical.sourceId || (registration.registered && "planeId" in registration && registration.planeId === footprint.planeId);
        return isFloorPlacement && isRegisteredPlane && footprint.visibility === "visible" && footprint.confidence >= 0.75;
      });
      if (!candidates.length) continue;
      const mappedParts = candidates.map((footprint) => mapRegisteredFootprint(footprint, view.sourceId, canonical.sourceId, registration));
      if (mappedParts.every((part) => part && part.outer.every(validPoint))) footprints.push({
        sourceId: view.sourceId,
        parts: mappedParts as NonNullable<MultiViewObservation["groundFootprints"]>,
        confidence: Math.min(...candidates.map((footprint) => footprint.confidence)),
      });
    }
    const rankedFootprints = [...footprints].sort((a, b) => b.confidence - a.confidence || a.sourceId.localeCompare(b.sourceId));
    let groundFootprints = row.groundFootprints;
    if (rankedFootprints.length) {
      const selected = rankedFootprints[0];
      const conflict = rankedFootprints.some((candidate) => footprintBoundsOverlap(selected.parts, candidate.parts) < 0.35);
      const canonicalFootprint = rankedFootprints.find((candidate) => candidate.sourceId === canonical.sourceId);
      const accepted = conflict ? canonicalFootprint : selected;
      if (conflict) geometryReviewEntityIds.add(row.entityId);
      if (accepted) {
        groundFootprints = accepted.parts;
        evidenceSourceIds.add(accepted.sourceId);
      }
    }
    sourceIdsByEntity[row.entityId] = [...evidenceSourceIds].sort().slice(0, 3);
    return {
      id: row.entityId, name: entity.name, category: entity.category, semanticType: entity.semanticType,
      bbox: row.bbox!, confidence: row.confidence * entity.identityConfidence, visibility: row.visibility,
      placement: entity.placement, mainColor: row.mainColor,
      groundContacts: fusedContacts.length ? fusedContacts : undefined,
      groundFootprints,
      occludesIds: row.occludesEntityIds, contactWallSide: row.contactWallSide,
      bodyExtendsToward: row.bodyExtendsToward, rearFeature: row.rearFeature,
      visibleBbox: row.visibleBbox, completeBbox: row.completeBbox, ...relationships.get(row.entityId),
    } satisfies ImageObservationItem;
  });
  const people = rows.filter((row) => entityById.get(row.entityId)?.kind === "person").map((row) => ({
    id: row.entityId, name: entityById.get(row.entityId)!.name, bbox: row.bbox!, confidence: row.confidence,
    visibility: row.visibility, posture: entityById.get(row.entityId)?.posture, facingDirection: row.facingDirection,
    kneelVariant: entityById.get(row.entityId)?.kneelVariant, handGesture: entityById.get(row.entityId)?.handGesture, supportId: relationships.get(row.entityId)?.supportId,
  } satisfies ImageObservationPerson));
  return { spaceType: contract.spaceType, surfaces, items, people, geometryEvidence: canonical.geometryEvidence,
    groundEvidenceSourceIds: sourceIdsByEntity, multiViewRelationReviewEntityIds: [...relationReviewEntityIds],
    multiViewGeometryReviewEntityIds: [...geometryReviewEntityIds], uncertainEntityIds: contract.entities.filter((entity) => entity.uncertain).map((entity) => entity.id),
    derivedGroundPlacements } as ImageObservation;
}
