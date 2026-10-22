import { describe, expect, it } from "vitest";
import {
  fitGroundPlaneHomography,
  multiViewToCanonicalObservation,
  registerGroundViews,
  selectCanonicalFrame,
  type Correspondence,
  type MultiViewContract,
  type MultiViewFrame,
} from "./multiViewObservation";

const points: [number, number][] = [[0.12, 0.12], [0.82, 0.12], [0.82, 0.82], [0.12, 0.82], [0.43, 0.51], [0.68, 0.36]];
const translate = ([x, y]: [number, number]): [number, number] => [x + 0.1, y + 0.02];
const correspondences = (count = points.length): Correspondence[] => points.slice(0, count).map((source, index) => ({
  source, target: translate(source), pointId: `p${index}`, confidence: 0.95,
}));

function baseContract(): MultiViewContract {
  const entities: MultiViewContract["entities"] = [
    { id: "floor", kind: "surface", name: "floor", surfaceKind: "floor", identityConfidence: 0.95, uncertain: false },
    { id: "chair", kind: "item", name: "chair", semanticType: "chair", category: "chair", placement: "floor", identityConfidence: 0.9, uncertain: false },
  ];
  const frame = (sourceId: string, chairBox: [number, number, number, number], landmarks: MultiViewFrame["groundLandmarks"]): MultiViewFrame => ({
    sourceId,
    entities: [
      { entityId: "floor", side: "floor", bbox: [0, 0, 1, 1], confidence: 0.95, visibility: "visible", mainColor: null },
      { entityId: "chair", bbox: chairBox, confidence: 0.9, visibility: "visible", mainColor: null },
    ],
    groundLandmarks: landmarks,
  });
  return {
    contractVersion: "image-observations-v2",
    spaceType: "enclosed",
    entities,
    views: [
      frame("a", [0.2, 0.2, 0.4, 0.7], points.map((point, index) => ({ pointId: `p${index}`, planeId: "floor", point: translate(point), confidence: 0.95, visibility: "visible" }))),
      frame("b", [0.65, 0.15, 0.92, 0.82], points.map((point, index) => ({ pointId: `p${index}`, planeId: "floor", point, confidence: 0.95, visibility: "visible" }))),
    ],
    relations: [],
  };
}

describe("multi-view ground registration", () => {
  it("fits deterministically across input order and requires held-out evidence", () => {
    const forward = fitGroundPlaneHomography(correspondences());
    const shuffled = fitGroundPlaneHomography(correspondences().reverse());
    expect(forward.registered).toBe(true);
    expect(shuffled.registered).toBe(true);
    if (forward.registered && shuffled.registered) {
      expect(forward.inlierPointIds).toEqual(shuffled.inlierPointIds);
      forward.homography.forEach((value, index) => expect(value).toBeCloseTo(shuffled.homography[index], 8));
    }
    expect(fitGroundPlaneHomography(correspondences(4))).toMatchObject({ registered: false, reason: "insufficient-correspondences" });
  });

  it("rejects outliers unless at least five reliable ground points validate a plane map", () => {
    const withOutlier = correspondences();
    withOutlier[5] = { ...withOutlier[5], target: [0.91, 0.08] };
    expect(fitGroundPlaneHomography(withOutlier)).toMatchObject({ registered: true, inlierPointIds: ["p0", "p1", "p2", "p3", "p4"] });
    expect(fitGroundPlaneHomography(correspondences().map((point, index) => ({ ...point, source: [0.1 + index * 0.1, 0.2 + index * 0.1] })))).toMatchObject({ registered: false, reason: "degenerate-coverage" });
    expect(fitGroundPlaneHomography(correspondences().map((point, index) => ({ ...point, pointId: index === 5 ? "p4" : point.pointId })))).toMatchObject({ registered: false, reason: "duplicate-point-id" });
  });

  it("carries the registered floor plane and fuses only ground contacts, never another view's bbox", () => {
    const contract = baseContract();
    contract.views[0].entities.find((row) => row.entityId === "chair")!.groundContacts = [
      { point: [0.45, 0.6], kind: "center", visibility: "visible", confidence: 0.9, pointId: "seat-center", planeId: "floor" },
    ];
    contract.views[1].entities.find((row) => row.entityId === "chair")!.groundContacts = [
      { point: [0.35, 0.59], kind: "center", visibility: "visible", confidence: 0.9, pointId: "seat-center", planeId: "floor" },
    ];
    const registration = registerGroundViews(contract, contract.views[0]).find((entry) => entry.sourceId === "b");
    expect(registration).toMatchObject({ registered: true, planeId: "floor" });
    const observation = multiViewToCanonicalObservation(contract, contract.views[0]);
    expect(observation.items[0].bbox).toEqual([0.2, 0.2, 0.4, 0.7]);
    expect(observation.items[0].groundContacts?.[0].point[0]).toBeCloseTo(0.45, 2);
    expect(observation.items[0].groundContacts?.[0].point[1]).toBeCloseTo(0.605, 3);
    contract.views[1].entities.find((row) => row.entityId === "chair")!.groundContacts = [];
    const canonicalOnly = multiViewToCanonicalObservation(contract, contract.views[0]);
    expect(canonicalOnly.items[0].groundContacts?.[0].point[1]).toBeCloseTo(0.6, 3);
  });

  it("limits cross-view contacts to six stable high-confidence points and marks evidence conflicts", () => {
    const contract = baseContract();
    const third: MultiViewFrame = {
      ...contract.views[1], sourceId: "c",
      entities: contract.views[1].entities.map((entry) => ({ ...entry })),
      groundLandmarks: contract.views[1].groundLandmarks?.map((point) => ({ ...point })),
    };
    contract.views.push(third);
    for (const [index, frame] of contract.views.entries()) {
      frame.entities.find((row) => row.entityId === "chair")!.groundContacts = points.slice(0, 6).map((point, pointIndex) => ({
        point: index === 0 ? translate(point) : point,
        kind: "corner" as const,
        visibility: "visible" as const,
        confidence: [0.9, 0.99, 0.8][index],
        pointId: `${frame.sourceId}-contact-${pointIndex}`,
        planeId: "floor",
      }));
    }
    const converted = multiViewToCanonicalObservation(contract, contract.views[0]) as ReturnType<typeof multiViewToCanonicalObservation> & { groundEvidenceSourceIds?: Record<string, string[]> };
    expect(converted.items[0].groundContacts).toHaveLength(6);
    expect(converted.items[0].groundContacts?.every((contact) => contact.point[0] >= 0.09 && contact.point[0] <= 0.94)).toBe(true);
    expect(converted.groundEvidenceSourceIds?.chair).toEqual(["b"]);

    const conflictingKind = baseContract();
    conflictingKind.views[0].entities.find((row) => row.entityId === "chair")!.groundContacts = [
      { point: [0.45, 0.6], kind: "center", visibility: "visible", confidence: 0.9, pointId: "shared-point", planeId: "floor" },
    ];
    conflictingKind.views[1].entities.find((row) => row.entityId === "chair")!.groundContacts = [
      { point: [0.35, 0.58], kind: "corner", visibility: "visible", confidence: 0.9, pointId: "shared-point", planeId: "floor" },
    ];
    const conflicted = multiViewToCanonicalObservation(conflictingKind, conflictingKind.views[0]) as ReturnType<typeof multiViewToCanonicalObservation> & { multiViewGeometryReviewEntityIds?: string[] };
    expect(conflicted.multiViewGeometryReviewEntityIds).toContain("chair");
    expect(conflicted.items[0].groundContacts?.[0].kind).toBe("center");
  });

  it("keeps a registered off-frame floor object as a derived placement without inventing a bbox", () => {
    const contract = baseContract();
    contract.entities.push({ id: "vase", kind: "item", name: "vase", semanticType: "vase", category: "prop", placement: "floor", identityConfidence: 0.9, uncertain: true });
    contract.views[1].entities.push({
      entityId: "vase", bbox: [0.7, 0.3, 0.8, 0.7], confidence: 0.9, visibility: "visible", mainColor: null,
      groundContacts: [{ point: [0.6, 0.65], kind: "center", visibility: "visible", confidence: 0.9, pointId: "vase-center", planeId: "floor" }],
    });
    const observation = multiViewToCanonicalObservation(contract, contract.views[0]) as ReturnType<typeof multiViewToCanonicalObservation> & {
      derivedGroundPlacements?: Array<{ entityId: string; sourceId: string; sourceBbox: [number, number, number, number]; groundContacts: Array<{ point: [number, number] }> }>;
    };
    expect(observation.items.some((item) => item.id === "vase")).toBe(false);
    expect(observation.derivedGroundPlacements).toHaveLength(1);
    expect(observation.derivedGroundPlacements?.[0]).toMatchObject({ entityId: "vase", sourceId: "b" });
    expect(observation.derivedGroundPlacements?.[0].sourceBbox).toEqual([0.7, 0.3, 0.8, 0.7]);
    expect(observation.derivedGroundPlacements?.[0].groundContacts[0].point[0]).toBeCloseTo(0.7, 8);
    expect(observation.derivedGroundPlacements?.[0].groundContacts[0].point[1]).toBeCloseTo(0.67, 8);
  });
});

describe("automatic solve-frame quality", () => {
  it("ranks calibrated evidence before object count and stays stable under view reordering", () => {
    const contract = baseContract();
    const lines = (vp: [number, number], sources: [[number, number], [number, number]]) => ({
      segments: sources.map((start) => ({ start, end: vp, confidence: 0.95 })),
    });
    const calibrated: MultiViewFrame = {
      sourceId: "calibratable",
      entities: Array.from({ length: 2 }, (_, index) => ({ entityId: `a${index}`, bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number], confidence: 0.9, visibility: "visible" as const, mainColor: null })),
      geometryEvidence: { axes: [
        { axis: "lateral", ...lines([0.25, 0.5], [[0, 0.1], [0.8, 0.1]]) },
        { axis: "depth", ...lines([0.65, 0.2], [[0.1, 0.5], [0.9, 0.6]]) },
        { axis: "vertical", ...lines([0.5, 0.9], [[0.2, 0.1], [0.8, 0.15]]) },
      ] },
    };
    const manyObjects: MultiViewFrame = { sourceId: "many-boxes", entities: Array.from({ length: 20 }, (_, index) => ({ entityId: `b${index}`, bbox: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, visibility: "visible", mainColor: null })) };
    contract.views = [manyObjects, calibrated];
    expect(selectCanonicalFrame(contract, { "calibratable": 1.8, "many-boxes": 1.8 }).sourceId).toBe("calibratable");
    contract.views.reverse();
    expect(selectCanonicalFrame(contract, { "calibratable": 1.8, "many-boxes": 1.8 }).sourceId).toBe("calibratable");
    expect(selectCanonicalFrame(contract, {}).sourceId).toBe("many-boxes");
    const equalCoverage = { ...contract, views: [manyObjects, { ...manyObjects, sourceId: "a-boxes" }] };
    expect(selectCanonicalFrame(equalCoverage, {}).sourceId).toBe("a-boxes");
  });
});
