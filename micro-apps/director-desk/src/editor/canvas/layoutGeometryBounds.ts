import { Box3, Matrix4, Vector3, type Group, type Mesh, type Object3D } from "three";

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
