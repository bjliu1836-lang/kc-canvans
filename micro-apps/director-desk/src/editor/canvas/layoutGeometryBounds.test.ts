import { Box3, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, TorusGeometry, Vector3, BoxGeometry } from "three";
import { describe, expect, it } from "vitest";
import { fitLayoutGeometryToUnitBounds } from "./layoutGeometryBounds";

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
