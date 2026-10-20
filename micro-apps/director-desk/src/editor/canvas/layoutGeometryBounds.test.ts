import { Box3, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, TorusGeometry, Vector3, BoxGeometry } from "three";
import { describe, expect, it } from "vitest";
import { deriveObservedAssemblyPrisms, fitLayoutGeometryToUnitBounds, getDefaultLayoutCategoryAssembly, getLayoutAssemblyUnitBoundsTransform } from "./layoutGeometryBounds";

function measuredLocalBounds(root: Group) {
  root.updateWorldMatrix(true, true);
  const inverse = root.parent?.matrixWorld.clone().invert() ?? new Group().matrixWorld.clone().invert();
  const bounds = new Box3();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(inverse.clone().multiply(mesh.matrixWorld)));
  });
  return bounds;
}

function addMesh(group: Group, geometry: Mesh["geometry"], position: [number, number, number], size: [number, number, number]) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.position.set(...position);
  mesh.scale.set(...size);
  group.add(mesh);
}

type CompositePart = { primitive: string; position: [number, number, number]; size: [number, number, number] };

describe("layout composite unit bounds", () => {
  it("clips assembly geometry to an observed L-shaped contour and preserves an interior hole", () => {
    const parts = [{ primitive: "box" as const, position: [0.5, 0.5, 0.5] as [number, number, number], size: [1, 1, 1] as [number, number, number] }];
    const lShape = [{ confidence: 0.98, outer: [[0, 0], [1, 0], [1, 0.4], [0.4, 0.4], [0.4, 1], [0, 1]] as [number, number][] }];
    const withHole = [{ confidence: 0.98, outer: [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][], holes: [[[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65]] as [number, number][]] }];
    const polygonArea = (polygon: [number, number][]) => Math.abs(polygon.reduce((sum, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)) / 2;
    const lPrisms = deriveObservedAssemblyPrisms(lShape, parts)!;
    const holePrisms = deriveObservedAssemblyPrisms(withHole, parts)!;
    expect(lPrisms.reduce((sum, part) => sum + polygonArea(part.polygon), 0)).toBeCloseTo(0.64, 5);
    expect(holePrisms.reduce((sum, part) => sum + polygonArea(part.polygon), 0)).toBeCloseTo(0.91, 5);
  });

  it("keeps table leg-to-top gaps when applying an observed floor mask", () => {
    const table = [
      { primitive: "box" as const, position: [0.5, 0.91, 0.5] as [number, number, number], size: [0.98, 0.12, 0.92] as [number, number, number] },
      ...[0.1, 0.9].flatMap((x) => [0.1, 0.9].map((z) => ({ primitive: "box" as const, position: [x, 0.4, z] as [number, number, number], size: [0.11, 0.72, 0.11] as [number, number, number] }))),
    ];
    const footprint = [{ confidence: 0.95, outer: [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][] }];
    const prisms = deriveObservedAssemblyPrisms(footprint, table)!;
    expect(prisms.some((part) => part.yMin < 0.01 && part.yMax > 0.35)).toBe(true);
    expect(prisms.some((part) => part.yMin < 0.7 && part.yMax > 0.7 && part.polygon.some(([x, z]) => x > 0.4 && x < 0.6 && z > 0.4 && z < 0.6))).toBe(false);
    expect(prisms.some((part) => part.yMin < 0.99 && part.yMax > 0.99)).toBe(true);
  });

  it("uses a parser-accepted medium-confidence footprint for the actual prism", () => {
    const parts = getDefaultLayoutCategoryAssembly("sofa")!;
    const footprint = [{ confidence: 0.65, outer: [[0, 0], [1, 0], [1, 0.4], [0.4, 0.4], [0.4, 1], [0, 1]] as [number, number][] }];
    const prisms = deriveObservedAssemblyPrisms(footprint, parts)!;
    const area = prisms.reduce((sum, part) => sum + Math.abs(part.polygon.reduce((polySum, point, index) => {
      const next = part.polygon[(index + 1) % part.polygon.length];
      return polySum + point[0] * next[1] - next[0] * point[1];
    }, 0)) / 2, 0);
    expect(area).toBeGreaterThan(0.1);
    expect(area).toBeLessThan(2);
    expect(prisms.flatMap((prism) => prism.polygon).every(([x, z]) => !(x > 0.400001 && z > 0.400001))).toBe(true);
    const yaw = 37 * Math.PI / 180, width = 3.4, depth = 2.2;
    const halfX = (Math.abs(Math.cos(yaw) * width) + Math.abs(Math.sin(yaw) * depth)) / 2;
    const halfZ = (Math.abs(Math.sin(yaw) * width) + Math.abs(Math.cos(yaw) * depth)) / 2;
    for (const prism of prisms) for (const [x, z] of prism.polygon) {
      const localX = (x - 0.5) * width, localZ = (z - 0.5) * depth;
      const worldX = Math.cos(yaw) * localX + Math.sin(yaw) * localZ;
      const worldZ = -Math.sin(yaw) * localX + Math.cos(yaw) * localZ;
      expect(Math.abs(worldX)).toBeLessThanOrEqual(halfX + 1e-8);
      expect(Math.abs(worldZ)).toBeLessThanOrEqual(halfZ + 1e-8);
    }
  });

  it("uses the renderer's fitted bounds for a rotated, non-uniform assembly proxy", () => {
    const parts = [
      { primitive: "box" as const, position: [0.3, 0.82, 0.55] as [number, number, number], size: [0.92, 0.14, 0.7] as [number, number, number], rotation: [0, 27, 0] as [number, number, number] },
      { primitive: "cylinder" as const, position: [0.5, 0.4, 0.5] as [number, number, number], size: [0.12, 0.76, 0.12] as [number, number, number] },
      { primitive: "box" as const, position: [0.7, 0.1, 0.5] as [number, number, number], size: [0.12, 0.2, 0.12] as [number, number, number], rotation: [8, 0, -4] as [number, number, number] },
    ];
    const content = new Group();
    for (const part of parts) {
      const geometry = part.primitive === "cylinder" ? new CylinderGeometry(0.5, 0.5, 1, 18) : new BoxGeometry(1, 1, 1);
      const mesh = new Mesh(geometry, new MeshStandardMaterial());
      mesh.position.set(...part.position);
      mesh.scale.set(...part.size);
      if (part.rotation) mesh.rotation.set(...part.rotation.map((value) => value * Math.PI / 180) as [number, number, number]);
      content.add(mesh);
    }
    const expected = getLayoutAssemblyUnitBoundsTransform(parts)!;
    const actual = fitLayoutGeometryToUnitBounds(content)!;
    expect(actual.position).toEqual(expected.position);
    expect(actual.scale).toEqual(expected.scale);
  });

  it("fits every built-in composite family and keeps declared component dimensions", () => {
    const assemblies: CompositePart[][] = [
      // table: top and four legs
      [{ primitive: "box", position: [0, 0.88, 0], size: [1, 0.12, 0.72] }, ...[-0.42, 0.42].flatMap((x) => [-0.28, 0.28].map((z) => ({ primitive: "box", position: [x, 0.42, z] as [number, number, number], size: [0.1, 0.78, 0.1] as [number, number, number] })))],
      // chair: seat, back, legs
      [{ primitive: "box", position: [0, 0.47, 0.04], size: [0.78, 0.12, 0.72] }, { primitive: "box", position: [0, 0.75, -0.32], size: [0.78, 0.56, 0.12] }, ...[-0.3, 0.3].flatMap((x) => [-0.24, 0.24].map((z) => ({ primitive: "box", position: [x, 0.23, z] as [number, number, number], size: [0.08, 0.48, 0.08] as [number, number, number] })))],
      // sofa: base, back and arms
      [{ primitive: "box", position: [0, 0.28, 0], size: [1, 0.5, 0.82] }, { primitive: "box", position: [0, 0.68, -0.3], size: [1, 0.56, 0.2] }, { primitive: "box", position: [-0.44, 0.5, 0.02], size: [0.14, 0.48, 0.8] }, { primitive: "box", position: [0.44, 0.5, 0.02], size: [0.14, 0.48, 0.8] }],
      // cabinet with front panel
      [{ primitive: "box", position: [0, 0.5, 0], size: [1, 1, 1] }, { primitive: "box", position: [0, 0.5, 0.506], size: [0.9, 0.88, 0.025] }],
      // incense burner, vase and Buddha (the latter historically exceeded Y=0..1)
      [{ primitive: "cylinder", position: [0, 0.34, 0], size: [0.86, 0.42, 0.86] }, { primitive: "torus", position: [0, 0.62, 0], size: [1.04, 0.08, 1.04] }],
      [{ primitive: "sphere", position: [0, 0.34, 0], size: [0.74, 0.62, 0.74] }, { primitive: "cylinder", position: [0, 0.7, 0], size: [0.32, 0.45, 0.32] }],
      [{ primitive: "box", position: [0, 0.22, 0], size: [0.86, 0.28, 0.56] }, { primitive: "cylinder", position: [0, 0.66, 0], size: [0.44, 0.72, 0.3] }, { primitive: "sphere", position: [0, 1.12, 0], size: [0.34, 0.34, 0.34] }],
    ];
    const geometryFor = (primitive: string) => primitive === "cylinder" ? new CylinderGeometry(0.5, 0.5, 1, 18)
      : primitive === "sphere" ? new SphereGeometry(0.5, 18, 12)
        : primitive === "torus" ? new TorusGeometry(0.5, 0.08, 10, 20)
          : new BoxGeometry(1, 1, 1);

    let foundOutOfBoundsComposite = false;
    for (const parts of assemblies) {
      const parent = new Group();
      parent.position.set(4, 0.7, -2);
      parent.rotation.y = 0.63;
      parent.scale.set(2.1, 0.8, 1.4);
      const content = new Group();
      parent.add(content);
      for (const { primitive, position, size } of parts) addMesh(content, geometryFor(primitive), position, size);
      parent.updateWorldMatrix(true, true);

      const before = measuredLocalBounds(content);
      foundOutOfBoundsComposite ||= before.min.y < 0 || before.max.y > 1 || before.min.x < -0.5 || before.max.x > 0.5 || before.min.z < -0.5 || before.max.z > 0.5;
      fitLayoutGeometryToUnitBounds(content);
      const fitted = measuredLocalBounds(content);
      expect(fitted.min.y).toBeCloseTo(0, 5);
      expect(fitted.max.y).toBeCloseTo(1, 5);
      expect(fitted.min.x).toBeGreaterThanOrEqual(-0.50001);
      expect(fitted.max.x).toBeLessThanOrEqual(0.50001);
      expect(fitted.min.z).toBeGreaterThanOrEqual(-0.50001);
      expect(fitted.max.z).toBeLessThanOrEqual(0.50001);

      const once = content.matrix.clone();
      fitLayoutGeometryToUnitBounds(content);
      expect(content.matrix.elements).toEqual(once.elements);
      const worldOrigin = content.localToWorld(new Vector3(0, 0, 0));
      expect(worldOrigin.toArray().every(Number.isFinite)).toBe(true);
      parent.clear();
    }
    expect(foundOutOfBoundsComposite).toBe(true);
  });
});
