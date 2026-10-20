import type { LayoutDraft } from "./layoutDraft";

export type NormalizedImagePoint = readonly [x: number, y: number];
export type GroundAxis = "lateral" | "depth" | "vertical";
export interface ImageLineSegment { start: NormalizedImagePoint; end: NormalizedImagePoint; confidence: number }
export interface GroundAxisEvidence { axis: GroundAxis; segments: readonly ImageLineSegment[] }
export interface ReferenceGroundEvidence { axes: readonly GroundAxisEvidence[] }
export interface GroundContactEvidence { point: NormalizedImagePoint; kind: "center" | "corner" | "edge"; visibility: "visible" | "inferred"; confidence: number }
export interface CalibratedGroundCamera {
  camera: NonNullable<LayoutDraft["referenceCamera"]>;
  confidence: number;
  status: "calibrated" | "partial" | "degenerate";
  evidenceAxes: GroundAxis[];
  focalLengthY: number;
  cameraHeightMeters: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Intersect the least-squares homogeneous line fit. Returns undefined for parallel or weak evidence. */
export function estimateVanishingPoint(segments: readonly ImageLineSegment[]): NormalizedImagePoint | undefined {
  if (segments.length < 2) return undefined;
  let xx = 0, xy = 0, yy = 0, xb = 0, yb = 0;
  let useful = 0;
  for (const segment of segments) {
    const dx = segment.end[0] - segment.start[0], dy = segment.end[1] - segment.start[1];
    const length = Math.hypot(dx, dy);
    if (length < 0.025 || segment.confidence < 0.45) continue;
    // ax + by + c = 0, with (a,b) the unit normal.
    const a = -dy / length, b = dx / length, c = -(a * segment.start[0] + b * segment.start[1]);
    const weight = segment.confidence * Math.min(1, length * 4);
    xx += weight * a * a; xy += weight * a * b; yy += weight * b * b;
    xb -= weight * a * c; yb -= weight * b * c; useful++;
  }
  const determinant = xx * yy - xy * xy;
  if (useful < 2 || determinant < 1e-5) return undefined;
  const point: NormalizedImagePoint = [(xb * yy - yb * xy) / determinant, (yb * xx - xb * xy) / determinant];
  if (!point.every(Number.isFinite) || Math.abs(point[0]) > 40 || Math.abs(point[1]) > 40) return undefined;
  return point;
}

/**
 * Calibrate a level-roll perspective camera from orthogonal room axes. Principal point is
 * assumed at image center and world up is fixed. The metric scale comes only from the
 * explicit camera-height prior, so callers must retain low confidence for single images.
 */
export function calibrateGroundCamera(
  evidence: ReferenceGroundEvidence,
  aspect: number,
  cameraHeightMeters = 1.55,
): CalibratedGroundCamera | undefined {
  if (!Number.isFinite(aspect) || aspect < 0.2 || aspect > 5 || cameraHeightMeters < 0.5 || cameraHeightMeters > 3) return undefined;
  const byAxis = new Map(evidence.axes.map((entry) => [entry.axis, entry]));
  const vp = new Map<GroundAxis, NormalizedImagePoint>();
  for (const axis of ["lateral", "depth", "vertical"] as const) {
    const point = estimateVanishingPoint(byAxis.get(axis)?.segments ?? []);
    if (point) vp.set(axis, point);
  }
  const lateral = vp.get("lateral"), depth = vp.get("depth"), vertical = vp.get("vertical");
  if (!depth && !vertical) return undefined;
  const dx = depth ? (depth[0] - 0.5) * aspect : 0;
  const dy = depth ? 0.5 - depth[1] : 0;
  const vy = vertical ? 0.5 - vertical[1] : 0;
  const focalSquared = depth && vertical ? -dy * vy : Number.NaN;
  // Parallel/near-parallel evidence cannot determine focal length. Keep a bounded prior
  // and report partial calibration rather than rejecting useful orientation evidence.
  const hasMetricIntrinsics = Number.isFinite(focalSquared) && focalSquared >= 0.12 && focalSquared <= 25;
  const focalLengthY = hasMetricIntrinsics ? Math.sqrt(focalSquared) : 0.9;
  // For a downward camera, the up vanishing point lies below the principal point in
  // camera Y coordinates (image Y is inverted): vy = -f*cot(pitch).
  const reliableVertical = vertical && vy < -0.03;
  const pitch = reliableVertical ? Math.atan2(focalLengthY, -vy)
    : depth ? Math.atan2(Math.max(0.008, dy), focalLengthY) : 0.08;
  if (pitch < 0.008 || pitch > 1.15) return undefined;
  const verticalX = vertical ? (vertical[0] - 0.5) * aspect : 0;
  if (Math.abs(verticalX) > 0.055) return undefined; // unsupported roll/principal-point shift.
  // depth VP x = -f*tan(yaw)/cos(pitch), with normalized X scaled by image aspect.
  const yaw = depth ? Math.atan2(-dx * Math.cos(pitch), focalLengthY) : 0;
  const forward: [number, number, number] = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const fullDistance = cameraHeightMeters / Math.sin(pitch);
  const target: [number, number, number] = [0, 0, 0];
  const position: [number, number, number] = fullDistance <= 30
    ? [-forward[0] * fullDistance, -forward[1] * fullDistance, -forward[2] * fullDistance]
    : [0, cameraHeightMeters, 0];
  // Camera position is a free world gauge. Keep it finite for near-level cameras;
  // the ground center naturally projects far away when the horizon is near center.
  if (fullDistance > 30) {
    target[0] = position[0] + forward[0] * 5;
    target[1] = position[1] + forward[1] * 5;
    target[2] = position[2] + forward[2] * 5;
  }
  const fov = 2 * Math.atan(0.5 / focalLengthY) * 180 / Math.PI;
  if (fov < 12 || fov > 125 || ![...position, ...target, fov].every(Number.isFinite)) return undefined;
  const orthogonality = lateral && depth && hasMetricIntrinsics
    ? Math.abs((lateral[0] - 0.5) * (depth[0] - 0.5) * aspect * aspect + (0.5 - lateral[1]) * (0.5 - depth[1]) + focalSquared) / Math.max(0.1, focalSquared)
    : 0.55;
  const confidence = clamp((hasMetricIntrinsics && reliableVertical ? 0.58 : 0.24) - orthogonality * 0.22 - (lateral ? 0 : 0.12) - (!reliableVertical ? 0.08 : 0), 0.05, 0.58);
  return {
    camera: { position, target, fov, projection: "perspective", source: "estimated", confidence, imageAspectRatio: aspect },
    confidence,
    status: hasMetricIntrinsics && lateral && orthogonality < 0.3 ? "calibrated" : "partial",
    evidenceAxes: [...vp.keys()],
    focalLengthY,
    cameraHeightMeters,
  };
}

export function projectImagePointToGround(
  point: NormalizedImagePoint,
  calibration: CalibratedGroundCamera,
  aspect: number,
): [number, number, number] | undefined {
  const { camera, focalLengthY } = calibration;
  const position = camera.position;
  const forwardRaw = [camera.target[0] - position[0], camera.target[1] - position[1], camera.target[2] - position[2]];
  const length = Math.hypot(...forwardRaw) || 1;
  const forward = forwardRaw.map((value) => value / length);
  const rightRaw = [-forward[2], 0, forward[0]];
  const rightLength = Math.hypot(rightRaw[0], rightRaw[2]) || 1;
  const right = [rightRaw[0] / rightLength, 0, rightRaw[2] / rightLength];
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const x = (point[0] - 0.5) * aspect / focalLengthY;
  const y = (0.5 - point[1]) / focalLengthY;
  const ray = [right[0] * x + up[0] * y + forward[0], right[1] * x + up[1] * y + forward[1], right[2] * x + up[2] * y + forward[2]];
  if (ray[1] >= -1e-4) return undefined;
  const distance = -position[1] / ray[1];
  if (!Number.isFinite(distance) || distance <= 0) return undefined;
  return [position[0] + ray[0] * distance, 0, position[2] + ray[2] * distance];
}

/** A lone corner/contact is not a component center; require explicit center or multiple points. */
export function estimateGroundContactCenter(
  contacts: readonly GroundContactEvidence[],
  calibration: CalibratedGroundCamera,
  aspect: number,
): { position: [number, number, number]; confidence: number; inferredCenter: boolean } | undefined {
  const usable = contacts.filter((contact) => contact.confidence >= 0.5 && (contact.visibility === "visible" || contact.confidence >= 0.8));
  const centers = usable.filter((contact) => contact.kind === "center" && contact.visibility === "visible");
  const points = centers.length ? centers : usable.filter((contact) => contact.kind !== "center");
  if (!centers.length && points.length < 2) return undefined;
  const projected = points.flatMap((contact) => {
    const position = projectImagePointToGround(contact.point, calibration, aspect);
    return position ? [{ position, confidence: contact.confidence * (contact.visibility === "visible" ? 1 : 0.45) }] : [];
  });
  if (!projected.length || (!centers.length && projected.length < 2)) return undefined;
  const total = projected.reduce((sum, item) => sum + item.confidence, 0);
  return {
    position: [projected.reduce((sum, item) => sum + item.position[0] * item.confidence, 0) / total, 0, projected.reduce((sum, item) => sum + item.position[2] * item.confidence, 0) / total],
    // A mean of visible feet/edges is only an initialization; occluded or concave
    // footprint geometry must be resolved by later silhouette/occupancy fitting.
    confidence: Math.min(centers.length ? 0.45 : 0.2, calibration.confidence * projected.reduce((sum, item) => sum + item.confidence, 0) / projected.length),
    inferredCenter: !centers.length,
  };
}
