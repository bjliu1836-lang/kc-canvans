import { Box3, BoxGeometry, ConeGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, ShapeUtils, SphereGeometry, TorusGeometry, Vector2, Vector3, type Group, type Mesh, type Object3D } from "three";

export type LayoutAssemblyBoundsPart = {
  primitive: "box" | "cylinder" | "sphere" | "cone" | "torus";
  position: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  opacity?: number;
};

export type ObservedGroundFootprintPart = { outer: [number, number][]; holes?: [number, number][][]; confidence: number };
export type LayoutPrismSection = { polygon: [number, number][]; yMin: number; yMax: number };
const assemblyBoundsCache = new WeakMap<object, LayoutUnitBoundsTransform | null>();
const observedPrismCache = new WeakMap<object, WeakMap<object, LayoutPrismSection[] | null>>();

/** Shared declarations for SceneRoot's category-level furniture geometry. */
export function getDefaultLayoutCategoryAssembly(category: string, descriptor = "", primitive: "box" | "cylinder" = "box"): LayoutAssemblyBoundsPart[] | undefined {
  const box = (position: [number, number, number], size: [number, number, number]): LayoutAssemblyBoundsPart => ({ primitive: "box", position, size });
  if (category === "table") return [box([0, 0.88, 0], [1, 0.12, 0.72]), ...[-0.42, 0.42].flatMap((x) => [-0.28, 0.28].map((z) => box([x, 0.42, z], [0.1, 0.78, 0.1])))];
  if (category === "chair") return [
    box([0, 0.47, 0.04], [0.78, 0.12, 0.72]), box([0, 0.75, -0.32], [0.78, 0.56, 0.12]),
    ...[-0.3, 0.3].flatMap((x) => [-0.24, 0.24].map((z) => box([x, 0.23, z], [0.08, 0.48, 0.08]))),
  ];
  if (category === "sofa") return [
    box([0, 0.28, 0], [1, 0.5, 0.82]), box([0, 0.68, -0.3], [1, 0.56, 0.2]),
    box([-0.44, 0.5, 0.02], [0.14, 0.48, 0.8]), box([0.44, 0.5, 0.02], [0.14, 0.48, 0.8]),
  ];
  if (category === "cabinet") return [box([0, 0.5, 0], [1, 1, 1]), box([0, 0.5, 0.506], [0.9, 0.88, 0.025])];
  if (category === "prop" && /(香炉|incense|urn)/i.test(descriptor)) return [
    { primitive: primitive === "cylinder" ? "cylinder" : "box", position: [0, 0.34, 0], size: [0.86, 0.42, 0.86] },
    { primitive: "torus", position: [0, 0.62, 0], size: [1.04, 0.08, 1.04] },
  ];
  if (category === "prop" && /(花瓶|vase)/i.test(descriptor)) return [
    { primitive: "sphere", position: [0, 0.34, 0], size: [0.74, 0.62, 0.74] },
    { primitive: "cylinder", position: [0, 0.7, 0], size: [0.32, 0.45, 0.32] },
  ];
  if (category === "prop" && /(佛像|buddha|雕像|statue)/i.test(descriptor)) return [
    box([0, 0.22, 0], [0.86, 0.28, 0.56]),
    { primitive: "cylinder", position: [0, 0.66, 0], size: [0.44, 0.72, 0.3] },
    { primitive: "sphere", position: [0, 1.12, 0], size: [0.34, 0.34, 0.34] },
  ];
  return undefined;
}

/**
 * Intersect image-observed plan topology with the actual horizontal projection
 * of each box in a render assembly. The returned unit-space prisms retain each
 * part's own vertical interval, so a table's open volume stays open.
 * Curved or tilted parts intentionally return undefined for conservative fallback.
 */
export function deriveObservedAssemblyPrisms(
  footprints: readonly ObservedGroundFootprintPart[] | undefined,
  parts: readonly LayoutAssemblyBoundsPart[] | undefined,
): LayoutPrismSection[] | undefined {
  // Keep the same acceptance boundary as imageObservationLayout: visible
  // footprints at 0.55 are applied there and must also shape rendered/collision
  // prisms. Lower-confidence and non-visible evidence is filtered upstream.
  if (!footprints?.length || !parts?.length || footprints.some((part) => part.confidence < 0.55)) return undefined;
  if (parts.some((part) => part.primitive !== "box" || Math.abs(part.rotation?.[0] ?? 0) > 1e-4 || Math.abs(part.rotation?.[2] ?? 0) > 1e-4)) return undefined;
  const nestedCache = observedPrismCache.get(parts as object);
  const cachedPrisms = nestedCache?.get(footprints as object);
  if (cachedPrisms !== undefined) return cachedPrisms ?? undefined;
  const cachePrisms = (value: LayoutPrismSection[] | undefined) => {
    const nested = observedPrismCache.get(parts as object) ?? new WeakMap<object, LayoutPrismSection[] | null>();
    nested.set(footprints as object, value ?? null);
    observedPrismCache.set(parts as object, nested);
    return value;
  };
  const transform = getLayoutAssemblyUnitBoundsTransform(parts, true);
  if (!transform) return cachePrisms(undefined);
  const clipConvex = (subject: [number, number][], clip: [number, number][]) => {
    let output = subject;
    const area = clip.reduce((sum, point, index) => {
      const next = clip[(index + 1) % clip.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    const oriented = area >= 0 ? clip : [...clip].reverse();
    for (let edge = 0; edge < oriented.length && output.length; edge += 1) {
      const a = oriented[edge], b = oriented[(edge + 1) % oriented.length];
      const input = output;
      output = [];
      const cross = (p: [number, number]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      for (let i = 0; i < input.length; i += 1) {
        const current = input[i], previous = input[(i + input.length - 1) % input.length];
        const ci = cross(current), pi = cross(previous);
        if ((ci >= -1e-8) !== (pi >= -1e-8)) {
          const t = pi / (pi - ci);
          output.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]);
        }
        if (ci >= -1e-8) output.push(current);
      }
    }
    return output;
  };
  const area = (polygon: [number, number][]) => Math.abs(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  const result: LayoutPrismSection[] = [];
  for (const footprint of footprints) {
    const contour = footprint.outer.map(([x, z]) => new Vector2(x, z));
    const holes = (footprint.holes ?? []).map((hole) => hole.map(([x, z]) => new Vector2(x, z)));
    const triangles = ShapeUtils.triangulateShape(contour, holes);
    // Three may normalize contour winding while triangulating, so flatten the
    // point list afterwards to keep its indices paired with the final loops.
    const all = [...contour, ...holes.flat()];
    for (const part of parts) {
      const radians = (part.rotation?.[1] ?? 0) * Math.PI / 180;
      const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
        const x = part.position[0] + sx * part.size[0] / 2;
        const z = part.position[2] + sz * part.size[2] / 2;
        const rx = part.position[0] + Math.cos(radians) * (x - part.position[0]) + Math.sin(radians) * (z - part.position[2]);
        const rz = part.position[2] - Math.sin(radians) * (x - part.position[0]) + Math.cos(radians) * (z - part.position[2]);
        return [0.5 + transform.position[0] + rx * transform.scale[0], 0.5 + transform.position[2] + rz * transform.scale[2]];
      });
      const yMin = transform.position[1] + (part.position[1] - part.size[1] / 2) * transform.scale[1];
      const yMax = transform.position[1] + (part.position[1] + part.size[1] / 2) * transform.scale[1];
      for (const triangle of triangles) {
        const subject = triangle.map((index) => [all[index].x, all[index].y] as [number, number]);
        const polygon = clipConvex(subject, corners);
        if (polygon.length >= 3 && area(polygon) > 1e-7) result.push({ polygon, yMin, yMax });
      }
    }
  }
  return cachePrisms(result.length ? result : undefined);
}

export interface LayoutUnitBoundsTransform {
  position: [number, number, number];
  scale: [number, number, number];
  sourceBounds: Box3;
}

/**
 * Fit layout-only programmatic geometry into its declared local unit bounds.
 * Y is grounded at 0 and reaches 1; X/Z are centered and only shrink when
 * their real rendered bounds exceed the declared footprint.
 */
export function getLayoutUnitBoundsTransform(bounds: Box3): LayoutUnitBoundsTransform | null {
  if (bounds.isEmpty()) return null;
  const size = bounds.getSize(new Vector3());
  if (size.x <= 1e-6 || size.y <= 1e-6 || size.z <= 1e-6) return null;
  const scaleX = Math.min(1, 1 / size.x);
  const scaleY = 1 / size.y;
  const scaleZ = Math.min(1, 1 / size.z);
  const center = bounds.getCenter(new Vector3());
  return {
    position: [-center.x * scaleX, -bounds.min.y * scaleY, -center.z * scaleZ],
    scale: [scaleX, scaleY, scaleZ],
    sourceBounds: bounds.clone(),
  };
}

/** Compute the same fitted unit bounds used by the preview from serialized parts. */
export function getLayoutAssemblyUnitBoundsTransform(parts: readonly LayoutAssemblyBoundsPart[] | undefined, normalizeHorizontal = false): LayoutUnitBoundsTransform | null {
  if (!parts?.length) return null;
  const cached = normalizeHorizontal ? undefined : assemblyBoundsCache.get(parts as object);
  if (cached !== undefined) return cached;
  const bounds = new Box3();
  const partBounds = new Box3();
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const quaternion = new Quaternion();
  for (const part of parts) {
    const geometry = part.primitive === "cylinder" ? new CylinderGeometry(0.5, 0.5, 1, 18)
      : part.primitive === "sphere" ? new SphereGeometry(0.5, 14, 10)
      : part.primitive === "cone" ? new ConeGeometry(0.5, 1, 16)
          : part.primitive === "torus" ? new TorusGeometry(0.5, 0.08, 10, 20)
            : new BoxGeometry(1, 1, 1);
    geometry.computeBoundingBox();
    if (geometry.boundingBox) {
      position.set(...part.position);
      scale.set(...part.size);
      quaternion.setFromEuler(new Euler(...(part.rotation ?? [0, 0, 0]).map((value) => value * Math.PI / 180) as [number, number, number]));
      matrix.compose(position, quaternion, scale);
      partBounds.copy(geometry.boundingBox).applyMatrix4(matrix);
      bounds.union(partBounds);
    }
    geometry.dispose();
  }
  let transform = getLayoutUnitBoundsTransform(bounds);
  if (normalizeHorizontal && transform) {
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const scaleX = 1 / size.x, scaleZ = 1 / size.z;
    transform = { ...transform, position: [-center.x * scaleX, transform.position[1], -center.z * scaleZ], scale: [scaleX, transform.scale[1], scaleZ] };
  }
  if (!normalizeHorizontal) assemblyBoundsCache.set(parts as object, transform);
  return transform;
}

/** Measure actual mesh geometry in root-local space and apply the shared unit fit. */
export function fitLayoutGeometryToUnitBounds(root: Group): LayoutUnitBoundsTransform | null {
  root.position.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateWorldMatrix(true, true);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const bounds = new Box3();
  const meshBounds = new Box3();
  const meshToRoot = new Matrix4();
  root.traverse((node: Object3D) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    meshToRoot.multiplyMatrices(rootInverse, mesh.matrixWorld);
    meshBounds.copy(mesh.geometry.boundingBox).applyMatrix4(meshToRoot);
    bounds.union(meshBounds);
  });
  const transform = getLayoutUnitBoundsTransform(bounds);
  if (!transform) return null;
  root.position.set(...transform.position);
  root.scale.set(...transform.scale);
  root.updateMatrixWorld(true);
  return transform;
}
