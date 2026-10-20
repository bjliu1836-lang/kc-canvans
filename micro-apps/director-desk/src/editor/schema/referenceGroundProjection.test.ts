import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import {
  calibrateGroundCamera,
  estimateGroundContactCenter,
  estimateVanishingPoint,
  projectImagePointToGround,
  type GroundAxisEvidence,
} from "./referenceGroundProjection";

function project(camera: PerspectiveCamera, point: Vector3): [number, number] {
  const projected = point.clone().project(camera);
  return [(projected.x + 1) / 2, (1 - projected.y) / 2];
}

function cameraFixture(yawDegrees = 9, pitchDegrees = 22) {
  const yaw = yawDegrees * Math.PI / 180, pitch = pitchDegrees * Math.PI / 180;
  const forward = new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const height = 1.55;
  const position = forward.clone().multiplyScalar(-height / Math.sin(pitch));
  const camera = new PerspectiveCamera(50, 1.8, 0.01, 10000);
  camera.position.copy(position);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { camera, height };
}

function lineEvidence(camera: PerspectiveCamera): GroundAxisEvidence[] {
  const cases = [
    ["lateral", new Vector3(1, 0, 0), [new Vector3(0, 0.01, -3), new Vector3(0, 0.01, -1), new Vector3(0, 0.01, 1)]],
    ["depth", new Vector3(0, 0, 1), [new Vector3(-1, 0.01, 0), new Vector3(0, 0.01, 0), new Vector3(1, 0.01, 0)]],
    ["vertical", new Vector3(0, 1, 0), [new Vector3(-1, 0, -2), new Vector3(0, 0, -2), new Vector3(1, 0, -2)]],
  ] as const;
  return cases.map(([axis, direction, starts]) => ({
    axis: axis as GroundAxisEvidence["axis"],
    segments: starts.map((start) => ({
      start: project(camera, start), end: project(camera, start.clone().addScaledVector(direction, 4)), confidence: 0.95,
    })),
  }));
}

describe("reference ground projection", () => {
  it("recovers a centered upright perspective camera from independently projected parallel lines", () => {
    const { camera } = cameraFixture();
    const evidence = lineEvidence(camera);
    const depthVp = estimateVanishingPoint(evidence.find((axis) => axis.axis === "depth")!.segments)!;
    const verticalVp = estimateVanishingPoint(evidence.find((axis) => axis.axis === "vertical")!.segments)!;
    expect(depthVp).toBeDefined();
    expect(verticalVp).toBeDefined();
    const calibration = calibrateGroundCamera({ axes: evidence }, 1.8);
    expect(calibration?.status).toBe("calibrated");
    expect(calibration!.camera.fov).toBeCloseTo(camera.fov, 0);
    const recovered = new PerspectiveCamera(calibration!.camera.fov, 1.8, 0.01, 10000);
    recovered.position.fromArray(calibration!.camera.position);
    recovered.lookAt(...calibration!.camera.target);
    recovered.updateMatrixWorld(true);
    const recoveredVertical = recovered.position.clone().add(new Vector3(0, 1000, 0));
    const expected = project(camera, camera.position.clone().add(new Vector3(0, 1, 0).multiplyScalar(1000)));
    const actual = project(recovered, recoveredVertical);
    expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1])).toBeLessThan(0.015);
  });

  it("intersects explicit ground-center evidence and refuses one ambiguous footprint corner", () => {
    const { camera } = cameraFixture(-13, 24);
    const evidence = lineEvidence(camera);
    const calibration = calibrateGroundCamera({ axes: evidence }, 1.8)!;
    const known = new Vector3(1.1, 0, -1.8);
    const point = project(camera, known);
    const center = estimateGroundContactCenter([{ point, kind: "center", visibility: "visible", confidence: 0.95 }], calibration, 1.8);
    expect(center?.position[0]).toBeCloseTo(known.x, 1);
    expect(center?.position[2]).toBeCloseTo(known.z, 1);
    const roundTrip = projectImagePointToGround(point, calibration, 1.8)!;
    expect(roundTrip[0]).toBeCloseTo(known.x, 1);
    expect(roundTrip[2]).toBeCloseTo(known.z, 1);
    expect(estimateGroundContactCenter([{ point, kind: "corner", visibility: "visible", confidence: 0.95 }], calibration, 1.8)).toBeUndefined();
  });

  it("keeps a parallel vertical-axis camera as low-confidence partial evidence", () => {
    const { camera } = cameraFixture(2, 14);
    const evidence = lineEvidence(camera).filter((axis) => axis.axis !== "vertical");
    const calibration = calibrateGroundCamera({ axes: evidence }, 1.8);
    expect(calibration?.status).toBe("partial");
    expect(calibration!.confidence).toBeLessThan(0.3);
  });

  it("keeps truly parallel vertical-axis segments as partial rather than calibrated", () => {
    const { camera } = cameraFixture(5, 14);
    const evidence = lineEvidence(camera).map((axis) => axis.axis !== "vertical" ? axis : {
      ...axis,
      segments: [[0.18, 0.12], [0.46, 0.18], [0.73, 0.24]].map(([x, y]) => ({ start: [x, y] as [number, number], end: [x, y + 0.52] as [number, number], confidence: 0.95 })),
    });
    const vertical = evidence.find((axis) => axis.axis === "vertical")!;
    const calibration = calibrateGroundCamera({ axes: evidence }, 1.8);
    expect(estimateVanishingPoint(vertical.segments)).toBeUndefined();
    expect(calibration?.status).toBe("partial");
    expect(calibration!.confidence).toBeLessThan(0.3);
  });
});
