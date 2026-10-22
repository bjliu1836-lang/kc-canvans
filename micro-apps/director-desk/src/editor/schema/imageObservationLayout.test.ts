import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { buildLayoutBatch, createLayoutCharacterRenderAdapter, getLayoutComponentAssembly, getLayoutComponentRotationYDegrees, validateLayoutDraftCandidate } from "./layoutDraft";
import { buildDerivedGroundPlacementComponent, cameraFitBreakdown, cameraFitError, cameraWorldCorners, carryFittedParentMotion, fitReferenceCamera, fitReferenceScene, imageObservationToLayoutDraft, ImageObservationValidationError, normalizeImageObservation, type CameraFitPair } from "./imageObservationLayout";
import type { CalibratedGroundCamera } from "./referenceGroundProjection";
import type { LayoutDraftComponent } from "./layoutDraft";
import { resolveLayoutSemanticProfile } from "./layoutSemanticProfiles";
import { deriveObservedAssemblyPrisms } from "../canvas/layoutGeometryBounds";

const source = { sourceId: "observation_fixture", fileName: "reference.png" };

function projectedBox(component: LayoutDraftComponent, camera: { position: [number, number, number]; target: [number, number, number]; fov: number }, aspect: number) {
  const yaw = component.rotationYDegrees * Math.PI / 180;
  const focal = 0.5 / Math.tan(camera.fov * Math.PI / 360);
  const values = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => {
    const x = component.position[0] + Math.cos(yaw) * sx * component.size[0] / 2 + Math.sin(yaw) * sz * component.size[2] / 2;
    const y = component.position[1] + (sy + 1) * component.size[1] / 2;
    const z = component.position[2] - Math.sin(yaw) * sx * component.size[0] / 2 + Math.cos(yaw) * sz * component.size[2] / 2;
    const depth = camera.position[2] - z;
    return [0.5 + x * focal / aspect / depth, 0.5 - (y - camera.position[1]) * focal / depth] as const;
  })));
  return [Math.min(...values.map(([x]) => x)), Math.min(...values.map(([, y]) => y)), Math.max(...values.map(([x]) => x)), Math.max(...values.map(([, y]) => y))] as [number, number, number, number];
}

function projectedByThree(point: Vector3, camera: PerspectiveCamera): [number, number] {
  const projected = point.clone().project(camera);
  return [(projected.x + 1) / 2, (1 - projected.y) / 2];
}

function projectedBoxByThree(component: LayoutDraftComponent, camera: PerspectiveCamera): [number, number, number, number] {
  const yaw = component.rotationYDegrees * Math.PI / 180;
  const points = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => {
    const localX = sx * component.size[0] / 2, localZ = sz * component.size[2] / 2;
    return new Vector3(
      component.position[0] + Math.cos(yaw) * localX + Math.sin(yaw) * localZ,
      component.position[1] + (sy + 1) * component.size[1] / 2,
      component.position[2] - Math.sin(yaw) * localX + Math.cos(yaw) * localZ,
    );
  })));
  const boxes = points.map((point) => projectedByThree(point, camera));
  return [Math.min(...boxes.map(([x]) => x)), Math.min(...boxes.map(([, y]) => y)), Math.max(...boxes.map(([x]) => x)), Math.max(...boxes.map(([, y]) => y))];
}

function groundEvidenceFixture(aspect: number) {
  const yaw = 9 * Math.PI / 180, pitch = 22 * Math.PI / 180;
  const forward = new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const camera = new PerspectiveCamera(50, aspect, 0.01, 10000);
  camera.position.copy(forward.clone().multiplyScalar(-1.55 / Math.sin(pitch)));
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const project = (point: Vector3): [number, number] => {
    const projected = point.clone().project(camera);
    return [(projected.x + 1) / 2, (1 - projected.y) / 2];
  };
  const axes = ([
    ["lateral", new Vector3(1, 0, 0), [new Vector3(-0.4, 0.01, -2), new Vector3(0, 0.01, -2), new Vector3(0.4, 0.01, -2)]],
    ["depth", new Vector3(0, 0, 1), [new Vector3(-0.4, 0.01, -1), new Vector3(0, 0.01, -1), new Vector3(0.4, 0.01, -1)]],
    ["vertical", new Vector3(0, 1, 0), [new Vector3(-0.4, 0, -2), new Vector3(0, 0, -2), new Vector3(0.4, 0, -2)]],
  ] as const).map(([axis, direction, starts]) => ({
    axis,
    segments: starts.map((start) => ({ start: project(start), end: project(start.clone().addScaledVector(direction, 0.8)), confidence: 0.95 }))
      .filter(({ start, end }) => [...start, ...end].every((value) => value >= 0 && value <= 1)),
  }));
  return { camera, project, geometryEvidence: { axes } };
}

function bedObservation(side: "image_left" | "image_right") {
  const isRight = side === "image_right";
  return {
    spaceType: "enclosed",
    imageAspectRatio: 1.5,
    surfaces: [{
      id: "anchor_wall", kind: "wall", side,
      bbox: isRight ? [0.78, 0.2, 1, 0.64] : [0, 0.2, 0.22, 0.64], confidence: 0.95,
    }],
    items: [
      {
        id: "bed", name: "床体", semanticType: "bed", bbox: isRight ? [0.22, 0.39, 0.92, 0.66] : [0.08, 0.39, 0.78, 0.66],
        confidence: 0.98, visibility: "visible", mainColor: "#F5F0E6", againstSurfaceId: "anchor_wall",
      },
      {
        id: "headboard", name: "床头板", category: "cabinet", bbox: isRight ? [0.78, 0.4, 0.92, 0.52] : [0.08, 0.4, 0.22, 0.52],
        confidence: 0.9, visibility: "visible", mainColor: "#F0EBE0", partOfId: "bed",
      },
    ],
  };
}

describe("imageObservationToLayoutDraft", () => {
  it("normalizes explicit null relationships to no relation in the client observation model", () => {
    const parsed = normalizeImageObservation({
      surfaces: [],
      items: [{ id: "item", name: "item", semanticType: "prop", bbox: [0.1, 0.1, 0.4, 0.5], confidence: 0.8, visibility: "visible", supportId: null, partOfId: null, againstSurfaceId: null, contactWallSide: null }],
    });
    for (const field of ["supportId", "partOfId", "againstSurfaceId", "contactWallSide"] as const) {
      expect(parsed.items[0][field]).toBeUndefined();
    }
  });

  it("uses the same canonical X scale for generic bbox centers and widths at different image aspects", () => {
    const observation = {
      spaceType: "enclosed",
      surfaces: [],
      items: [{ id: "bench", name: "bench", category: "sofa", semanticType: "bench", bbox: [0.65, 0.4, 0.88, 0.76], confidence: 0.8, visibility: "visible", placement: "floor" }],
    };
    const layouts = [1, 1672 / 941].map((aspect) =>
      imageObservationToLayoutDraft(observation, source, { imageAspectRatio: aspect }).components[0],
    );

    for (const component of layouts) {
      expect(component.size[0]).toBeCloseTo(1.38);
      expect(component.position[0]).toBeCloseTo(1.59);
      expect(component.position[0] - component.size[0] / 2).toBeCloseTo(0.9);
      expect(component.position[0] + component.size[0] / 2).toBeCloseTo(2.28);
    }
    expect(layouts[0].size[0]).toBeCloseTo(layouts[1].size[0]);
    expect(layouts[0].position[0]).toBeCloseTo(layouts[1].position[0]);
    expect(layouts[1].uncertain).toBe(true);
    expect(layouts[0].sourceImageEvidence).toMatchObject({
      bbox: [0.65, 0.4, 0.88, 0.76],
      confidence: 0.8,
      visibility: "visible",
    });
  });

  it("rejects a lower-residual camera when it cannot project the observed floor", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "floor_main", kind: "floor", side: "floor", bbox: [0, 0.62, 1, 1], confidence: 0.98, visibility: "visible" },
        { id: "wall_back", kind: "wall", side: "image_back", bbox: [0, 0, 1, 0.62], confidence: 0.9, visibility: "partly_occluded" },
        { id: "wall_right", kind: "wall", side: "image_right", bbox: [0.72, 0, 1, 0.72], confidence: 0.9, visibility: "visible" },
        { id: "wall_left", kind: "wall", side: "image_left", bbox: [0, 0, 0.2, 0.62], confidence: 0.75, visibility: "partly_occluded" },
      ],
      items: [
        { id: "sofa_main", name: "大型组合沙发", category: "sofa", bbox: [0.07, 0.52, 0.59, 0.83], confidence: 0.97, visibility: "visible", placement: "floor" },
        { id: "coffee_table", name: "黑色茶几", category: "table", bbox: [0.42, 0.63, 0.62, 0.75], confidence: 0.95, visibility: "visible", placement: "floor" },
        { id: "rug_main", name: "客厅地毯", semanticType: "rug", category: "prop", bbox: [0, 0.62, 0.82, 0.9], confidence: 0.9, visibility: "visible", placement: "floor" },
        { id: "armchair_right", name: "棕色单人沙发椅", semanticType: "armchair", category: "sofa", bbox: [0.73, 0.6, 0.96, 0.88], confidence: 0.95, visibility: "visible", placement: "floor" },
        { id: "side_table", name: "黑色小边几", category: "table", bbox: [0.73, 0.7, 0.8, 0.88], confidence: 0.9, visibility: "visible", placement: "floor" },
        { id: "tv_cabinet", name: "电视柜", category: "cabinet", bbox: [0.73, 0.58, 0.99, 0.68], confidence: 0.9, visibility: "visible", contactWallSide: "image_right", placement: "floor" },
        { id: "plant_right", name: "室内绿植", semanticType: "potted plant", category: "prop", bbox: [0.64, 0.35, 0.72, 0.62], confidence: 0.9, visibility: "visible", placement: "floor" },
      ],
    }, source, { imageAspectRatio: 2 });
    const floor = draft.components.find((component) => component.id === "floor_main");
    const backWall = draft.components.find((component) => component.id === "wall_back");
    const rightWall = draft.components.find((component) => component.id === "wall_right");
    const fit = draft.referenceCamera?.fitDiagnostics;

    expect(fit?.floorProjectionRejectedCandidateCount).toBeGreaterThan(0);
    expect(fit?.qualityStatus).toBe("needsReview");
    expect(fit?.passedErrorThreshold).toBe(false);
    expect(floor?.size).toEqual([0.1, 0.02, 0.1]);
    expect(floor?.uncertain).toBe(true);
    expect(backWall?.size[0]).toBeCloseTo(6);
    expect(backWall?.position[2]).toBeCloseTo(-3);
    expect(backWall?.confidence).toBeLessThanOrEqual(0.35);
    expect(backWall?.uncertain).toBe(true);
    expect(rightWall?.position[0]).toBeCloseTo(3);
    expect(rightWall?.size[2]).toBeCloseTo(6);
    expect(rightWall?.confidence).toBeLessThanOrEqual(0.35);
    expect(rightWall?.uncertain).toBe(true);
  });

  it("back-projects visible ground footprints through conservative camera candidates when VP evidence is absent", () => {
    const aspect = 1.5;
    const fixture = groundEvidenceFixture(aspect);
    const truth: LayoutDraftComponent[] = [
      { id: "rug", name: "rug", category: "prop", primitive: "box", position: [-0.1, 0, -2.2], size: [3, 0.04, 1.8], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true },
      { id: "sofa", name: "sofa", category: "sofa", primitive: "box", position: [-0.45, 0, -2.25], size: [1.8, 0.78, 0.9], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true },
      { id: "chair", name: "chair", category: "chair", primitive: "box", position: [1.05, 0, -2.9], size: [0.8, 1.05, 0.72], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true },
    ];
    const projectFootprint = (component: LayoutDraftComponent) => {
      const { position: [x, , z], size: [width, , depth] } = component;
      return [[x - width / 2, z - depth / 2], [x + width / 2, z - depth / 2], [x + width / 2, z + depth / 2], [x - width / 2, z + depth / 2]]
        .map(([worldX, worldZ]) => fixture.project(new Vector3(worldX, 0, worldZ)));
    };
    const projectedRenderedBox = (component: LayoutDraftComponent) => {
      const points = cameraWorldCorners({ ...component, groundFootprint: [{ confidence: 0.95, outer: [[0, 0], [1, 0], [1, 1], [0, 1]] }] })
        .map(([x, y, z]) => fixture.project(new Vector3(x, y, z)));
      return [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y))] as [number, number, number, number];
    };
    const observation = {
      spaceType: "open", imageAspectRatio: aspect,
      surfaces: [{ id: "floor", kind: "floor", side: "floor", bbox: [0.02, 0.52, 0.98, 0.99], confidence: 0.95, visibility: "visible" }],
      // The scene has known truth in the test only. The observation deliberately
      // omits all camera and vanishing-point metadata.
      items: truth.map((component) => ({
        id: component.id, name: component.name, category: component.category,
        semanticType: component.id === "rug" ? "rug" : component.category,
        bbox: projectedRenderedBox(component), confidence: 0.95, visibility: "visible",
        placement: component.id === "sofa" ? "supported" : "floor",
        ...(component.id === "sofa" ? { supportId: "rug" } : {}),
        groundFootprints: [{ outer: projectFootprint(component), visibility: "visible", confidence: 0.95 }],
      })),
    };
    const draft = imageObservationToLayoutDraft(observation, source, { imageAspectRatio: aspect });
    const fitted = new Map(draft.components.map((component) => [component.id, component]));
    for (const expected of truth) {
      const component = fitted.get(expected.id)!;
      expect(component.groundFootprint, `${expected.id}: ${JSON.stringify(component)}`).toHaveLength(1);
      expect(component.groundFootprint?.[0].outer.length).toBe(4);
      expect(component.size[0]).toBeGreaterThan(0.02);
      expect(component.size[2]).toBeGreaterThan(0.02);
    }
    expect(fitted.get("sofa")?.supportComponentId).toBe("rug");
    const ratioError = (candidate: LayoutDraftComponent[], axes: Array<"widthDepth" | "widthHeight">) => truth.reduce((sum, expected) => {
      const actual = candidate.find((component) => component.id === expected.id)!;
      const errors = {
        widthDepth: Math.abs(Math.log(actual.size[0] / actual.size[2]) - Math.log(expected.size[0] / expected.size[2])),
        widthHeight: Math.abs(Math.log(actual.size[0] / actual.size[1]) - Math.log(expected.size[0] / expected.size[1])),
      };
      return sum + axes.reduce((axisSum, axis) => axisSum + errors[axis], 0);
    }, 0) / (truth.length * axes.length);
    const bboxOnly = imageObservationToLayoutDraft({ ...observation, items: observation.items.map(({ groundFootprints: _footprint, ...item }) => item) }, source, { imageAspectRatio: aspect });
    const fittedWdError = ratioError(draft.components, ["widthDepth"]);
    const priorWdError = ratioError(bboxOnly.components, ["widthDepth"]);
    const fittedWhError = ratioError(draft.components, ["widthHeight"]);
    const priorWhError = ratioError(bboxOnly.components, ["widthHeight"]);
    const relativePositionError = (candidate: LayoutDraftComponent[]) => {
      const byId = new Map(candidate.map((component) => [component.id, component]));
      const fitted = truth.map(({ id }) => byId.get(id)!);
      const pairs: Array<[number, number]> = [];
      for (let left = 0; left < truth.length; left += 1) for (let right = left + 1; right < truth.length; right += 1) {
        const actual = Math.hypot(fitted[left].position[0] - fitted[right].position[0], fitted[left].position[2] - fitted[right].position[2]);
        const expected = Math.hypot(truth[left].position[0] - truth[right].position[0], truth[left].position[2] - truth[right].position[2]);
        pairs.push([actual, expected]);
      }
      const scale = pairs.reduce((sum, [actual, expected]) => sum + actual * expected, 0)
        / pairs.reduce((sum, [actual]) => sum + actual * actual, 0);
      return Math.sqrt(pairs.reduce((sum, [actual, expected]) => sum + Math.pow(scale * actual - expected, 2), 0) / pairs.length)
        / Math.sqrt(pairs.reduce((sum, [, expected]) => sum + expected * expected, 0) / pairs.length);
    };
    const fittedPositionError = relativePositionError(draft.components);
    const priorPositionError = relativePositionError(bboxOnly.components);
    // Keep the three-object no-VP W:D:H comparison explicit against the same
    // semantic-size-only baseline after a single global scale alignment.
    expect([fittedWdError, priorWdError, fittedWhError, priorWhError].every(Number.isFinite)).toBe(true);
    expect(fittedWdError).toBeLessThan(priorWdError);
    expect(fittedWhError).toBeLessThan(priorWhError);
    expect(fittedPositionError).toBeLessThan(priorPositionError);
    expect(draft.referenceCamera?.fitDiagnostics?.candidateCount).toBeGreaterThan(0);
    expect(draft.referenceCamera?.fitDiagnostics?.physicalValidity?.finalPenetrationMeters)
      .toBeLessThanOrEqual(draft.referenceCamera?.fitDiagnostics?.physicalValidity?.initialPenetrationMeters ?? Infinity);
    const applied = buildLayoutBatch(draft, "unknown-camera-footprint-closure", []).objects;
    for (const component of truth) {
      expect(applied.find((item) => item.layoutSource?.componentId === component.id)?.layoutSource?.groundFootprint)
        .toEqual(fitted.get(component.id)?.groundFootprint);
    }
  });

  it("adds a safely projected off-frame entity with its original source-local crop evidence", () => {
    const aspect = 1.5;
    const fixture = groundEvidenceFixture(aspect);
    const anchors: LayoutDraftComponent[] = [
      { id: "anchor_rug", name: "rug", category: "prop", primitive: "box", position: [-0.8, 0, -2.2], size: [1.2, 0.04, 1], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true },
      { id: "anchor_sofa", name: "sofa", category: "sofa", primitive: "box", position: [-0.15, 0, -2.35], size: [1.1, 0.75, 0.65], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true },
      { id: "anchor_chair", name: "chair", category: "chair", primitive: "box", position: [0.75, 0, -2.8], size: [0.55, 0.85, 0.55], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true },
    ];
    const observation = {
      spaceType: "open", imageAspectRatio: aspect, geometryEvidence: fixture.geometryEvidence,
      surfaces: [],
      items: anchors.map((component) => ({ id: component.id, name: component.name, category: component.category, semanticType: component.category,
        bbox: projectedBoxByThree(component, fixture.camera), confidence: 0.98, visibility: "visible", placement: "floor" })),
    };
    const contact = fixture.project(new Vector3(1.25, 0, -2.7));
    const draft = imageObservationToLayoutDraft(observation, source, {
      imageAspectRatio: aspect,
      layoutResolution: { recognizedCount: 4, locatedCount: 3, unresolved: [{ entityId: "offframe_bed", name: "床", sourceId: "view_side", sourceFileName: "side.png", reason: "等待其他视图定位" }] },
      derivedGroundPlacements: [{
        entityId: "offframe_bed", name: "床", semanticType: "bed", category: "prop", confidence: 0.9, uncertain: false,
        sourceId: "view_side", sourceIds: ["view_side"], sourceBbox: [0.2, 0.3, 0.8, 0.72],
        groundContacts: [{ point: contact, kind: "center", visibility: "visible", confidence: 0.95 }], groundFootprints: [],
      }],
    });
    const derived = draft.components.find((component) => component.id === "offframe_bed");
    expect(derived).toBeUndefined();
    expect(draft.layoutResolution).toMatchObject({ recognizedCount: 4, locatedCount: 3, unresolved: [
      { entityId: "offframe_bed", reason: "最终参考机位缺少可信地面相机，已识别但暂不定位。" },
    ] });
  });

  it("projects a derived ground center through one trusted camera and carries its crop source into the applied batch", () => {
    const calibration = {
      camera: { projection: "perspective", position: [0, 1.6, 6.6], target: [0, 0.3, 0], fov: 60, confidence: 0.95, source: "estimated" },
      confidence: 0.95, status: "calibrated", evidenceAxes: [], focalLengthY: 0.866, cameraHeightMeters: 1.6,
    } as unknown as CalibratedGroundCamera;
    const result = buildDerivedGroundPlacementComponent({
      entityId: "offframe_bed", name: "床", semanticType: "bed", category: "prop", confidence: 0.9, uncertain: false,
      sourceId: "view_side", sourceIds: ["view_side"], sourceBbox: [0.2, 0.3, 0.8, 0.72],
      groundContacts: [{ point: [0.5, 0.7], kind: "center", visibility: "visible", confidence: 0.95 }], groundFootprints: [],
    }, calibration, 1.5);
    expect("component" in result).toBe(true);
    if (!("component" in result) || !result.component) throw new Error("reason" in result ? result.reason : "derived component missing");
    expect(result.component.category).toBe("sofa");
    expect(result.component.uncertain).toBe(true);
    expect(result.component.sourceImageEvidence).toMatchObject({ sourceId: "view_side", bbox: [0.2, 0.3, 0.8, 0.72] });
    const draft = validateLayoutDraftCandidate({
      spaceType: "open", sourceGroupKey: "view_front|view_side",
      layoutResolution: { recognizedCount: 2, locatedCount: 1, unresolved: [{ entityId: "other", name: "柜子", sourceId: "view_side", sourceFileName: "side.png", reason: "地面未配准" }] },
      components: [result.component],
    }, source, {
      draftId: "derived_projected", sourceGroupKey: "view_front|view_side",
      layoutResolution: { recognizedCount: 2, locatedCount: 1, unresolved: [{ entityId: "other", name: "柜子", sourceId: "view_side", sourceFileName: "side.png", reason: "地面未配准" }] },
    });
    const built = buildLayoutBatch(draft, "derived_batch", []);
    expect(built.objects[0].layoutSource).toMatchObject({ evidenceSourceId: "view_side", sourceGroupKey: "view_front|view_side" });
    expect(built.batch.layoutResolution?.unresolved).toMatchObject([{ entityId: "other", sourceFileName: "side.png", reason: "地面未配准" }]);
    expect(built.batch.objectIds).toContain("derived_batch_offframe_bed");
  });

  it("carries a sofa L-notch through parser, conversion, preview, rotation and apply", () => {
    const { geometryEvidence } = groundEvidenceFixture(1.5);
    const draft = imageObservationToLayoutDraft({
      spaceType: "open",
      imageAspectRatio: 1.5,
      geometryEvidence,
      surfaces: [{ id: "floor_main", kind: "floor", side: "floor", bbox: [0.05, 0.58, 0.95, 0.98], confidence: 0.98, visibility: "visible" }],
      items: [{
        id: "sectional_sofa", name: "组合沙发", semanticType: "sofa", category: "sofa", bbox: [0.24, 0.22, 0.76, 0.84],
        confidence: 0.98, visibility: "visible", placement: "floor", supportId: "floor_main",
        groundFootprints: [{ visibility: "visible", confidence: 0.98, outer: [[0.3, 0.58], [0.7, 0.58], [0.7, 0.7], [0.5, 0.7], [0.5, 0.9], [0.3, 0.9]] }],
      }],
    }, source, { imageAspectRatio: 1.5 });
    const sofa = draft.components.find(({ id }) => id === "sectional_sofa")!;
    expect(sofa.assembly).toBeUndefined(); // Category fallback must share the observed mask too.
    const assembly = getLayoutComponentAssembly(sofa)!;
    const componentPrisms = deriveObservedAssemblyPrisms(sofa.groundFootprint, assembly);
    expect(componentPrisms?.length).toBeGreaterThan(0);
    const fullPrisms = deriveObservedAssemblyPrisms([{ confidence: 0.98, outer: [[0, 0], [1, 0], [1, 1], [0, 1]] }], assembly)!;
    const area = (polygon: [number, number][]) => Math.abs(polygon.reduce((sum, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)) / 2;
    expect(componentPrisms!.reduce((sum, section) => sum + area(section.polygon), 0)).toBeLessThan(fullPrisms.reduce((sum, section) => sum + area(section.polygon), 0) * 0.9);
    const contour = sofa.groundFootprint![0].outer;
    const notchPoint: [number, number] = [(contour[2][0] + contour[4][0]) / 2, (contour[2][1] + contour[4][1]) / 2];
    const inside = (polygon: [number, number][], point: [number, number]) => {
      let result = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) if ((polygon[i][1] > point[1]) !== (polygon[j][1] > point[1]) && point[0] < (polygon[j][0] - polygon[i][0]) * (point[1] - polygon[i][1]) / (polygon[j][1] - polygon[i][1]) + polygon[i][0]) result = !result;
      return result;
    };
    expect(componentPrisms!.some((section) => inside(section.polygon, notchPoint))).toBe(false);

    const applied = buildLayoutBatch(draft, "apply_geometry_truth", []).objects.find(({ layoutSource }) => layoutSource?.componentId === "sectional_sofa")!;
    const appliedPrisms = deriveObservedAssemblyPrisms(applied.layoutSource?.groundFootprint, applied.layoutSource?.assembly);
    expect(applied.layoutSource?.groundFootprint).toEqual(sofa.groundFootprint);
    expect(appliedPrisms).toEqual(componentPrisms);
    const appliedYaw = applied.transform.rotation[1];
    const worldNotch: [number, number] = [applied.transform.position[0] + Math.cos(appliedYaw) * (notchPoint[0] - 0.5) * applied.transform.scale[0] + Math.sin(appliedYaw) * (notchPoint[1] - 0.5) * applied.transform.scale[2], applied.transform.position[2] - Math.sin(appliedYaw) * (notchPoint[0] - 0.5) * applied.transform.scale[0] + Math.cos(appliedYaw) * (notchPoint[1] - 0.5) * applied.transform.scale[2]];
    expect(worldNotch.every(Number.isFinite)).toBe(true);
    expect(appliedPrisms!.some((section) => inside(section.polygon.map(([x, z]) => [applied.transform.position[0] + Math.cos(appliedYaw) * (x - 0.5) * applied.transform.scale[0] + Math.sin(appliedYaw) * (z - 0.5) * applied.transform.scale[2], applied.transform.position[2] - Math.sin(appliedYaw) * (x - 0.5) * applied.transform.scale[0] + Math.cos(appliedYaw) * (z - 0.5) * applied.transform.scale[2]]), worldNotch))).toBe(false);
  });

  it.each([
    ["concave L opening", [[-1, -2], [1, -2], [1, -1], [0, -1], [0, 0], [-1, 0]], undefined, [0.5, -0.5]],
    ["closed footprint hole", [[-1, -2], [1, -2], [1, 0], [-1, 0]], [[[-0.3, -1.3], [0.3, -1.3], [0.3, -0.7], [-0.3, -0.7]]], [0, -1]],
  ] as const)("preserves %s as planar occupancy without turning the footprint into a solid render assembly", (_label, outerWorld, holesWorld, emptyPoint) => {
    const aspect = 1.8;
    const fixture = groundEvidenceFixture(aspect);
    const toImage = (point: readonly [number, number]) => fixture.project(new Vector3(point[0], 0, point[1]));
    const outer = outerWorld.map(toImage);
    const holes = holesWorld?.map((hole) => hole.map(toImage));
    const imagePoints = [...outer, ...(holes ?? []).flat()];
    const bbox = [Math.min(...imagePoints.map(([x]) => x)), Math.min(...imagePoints.map(([, y]) => y)), Math.max(...imagePoints.map(([x]) => x)), Math.max(...imagePoints.map(([, y]) => y))] as [number, number, number, number];
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", imageAspectRatio: aspect, geometryEvidence: fixture.geometryEvidence,
      surfaces: [],
      items: [{ id: "sectional", name: "L sectional sofa", semanticType: "sofa", category: "sofa", bbox, confidence: 0.95, visibility: "visible", placement: "floor", groundFootprints: [{ outer, ...(holes ? { holes } : {}), visibility: "visible", confidence: 0.95 }] }],
    }, source, { imageAspectRatio: aspect });
    const sectional = draft.components.find(({ id }) => id === "sectional")!;
    expect(sectional.groundFootprint).toHaveLength(1);
    expect(sectional.assembly).toBeUndefined();
    const toLocal = ([x, z]: readonly [number, number]): [number, number] => [(x - sectional.position[0]) / sectional.size[0] + 0.5, (z - sectional.position[2]) / sectional.size[2] + 0.5];
    const cavity = toLocal(emptyPoint);
    const polygonContains = (point: [number, number], loop: [number, number][]) => {
      let inside = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [x, y] = loop[i], [px, py] = loop[j];
        if ((y > point[1]) !== (py > point[1]) && point[0] < (px - x) * (point[1] - y) / (py - y) + x) inside = !inside;
      }
      return inside;
    };
    const shape = sectional.groundFootprint![0];
    expect(polygonContains(cavity, shape.outer)).toBe(Boolean(holes));
    if (shape.holes?.[0]) expect(polygonContains(cavity, shape.holes[0])).toBe(true);
  });

  it("preserves bounded Unicode semantic labels through conversion and keeps carpet geometry flat", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "rug_cn", name: "地毯", semanticType: " 地毯\u0001 ", category: "prop", bbox: [0.08, 0.68, 0.92, 0.96], confidence: 0.9, visibility: "visible" },
        { id: "rug_en", name: "Rug", semanticType: "rug", category: "prop", bbox: [0.1, 0.7, 0.9, 0.95], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const cn = draft.components.find((component) => component.id === "rug_cn")!;
    const en = draft.components.find((component) => component.id === "rug_en")!;
    expect(cn.semanticType).toBe("地毯");
    expect(cn.size[1]).toBe(0.08);
    expect(cn.size[0]).toBeGreaterThan(2);
    expect(en.semanticType).toBe("rug");
    expect(en.size[1]).toBe(0.08);
  });

  it("keeps explicit unknown semantics generic despite parent-context words in names, with legacy name fallback", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "tea_set", name: "茶几上的茶具", semanticType: "tea_set", bbox: [0.4, 0.35, 0.55, 0.58], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const teaSet = draft.components.find((component) => component.id === "tea_set")!;
    expect(teaSet.category).toBe("prop");
    expect(teaSet.size[1]).not.toBe(0.75);
    expect(resolveLayoutSemanticProfile(undefined, "茶几")?.category).toBe("table");
    expect(resolveLayoutSemanticProfile("uncatalogued_item", "地毯上的物品")).toBeUndefined();
  });

  it("normalizes known identities to one geometry category while keeping unknowns conservative", () => {
    const input = {
      spaceType: "open",
      surfaces: [],
      items: [
        { id: "bed_sofa_category", name: "bed", semanticType: "bed", category: "sofa", bbox: [0.33, 0.03, 0.62, 0.63], confidence: 0.95, visibility: "visible", placement: "floor", groundFootprints: [{ outer: [[0.34, 0.06], [0.61, 0.06], [0.62, 0.6], [0.33, 0.6]], visibility: "visible", confidence: 0.8 }] },
        { id: "bed_table_category", name: "bed", semanticType: "bed", category: "table", bbox: [0.33, 0.03, 0.62, 0.63], confidence: 0.95, visibility: "visible", placement: "floor", groundFootprints: [{ outer: [[0.34, 0.06], [0.61, 0.06], [0.62, 0.6], [0.33, 0.6]], visibility: "visible", confidence: 0.8 }] },
        { id: "bookshelf_table_category", name: "bookshelf", semanticType: "bookshelf", category: "table", bbox: [0.1, 0.2, 0.3, 0.8], confidence: 0.9, visibility: "visible", placement: "floor" },
        { id: "unknown_chair_category", name: "odd object", semanticType: "uncatalogued_object", category: "chair", bbox: [0.6, 0.2, 0.8, 0.8], confidence: 0.9, visibility: "visible", placement: "floor" },
      ],
    } as const;
    const original = structuredClone(input);
    const draft = imageObservationToLayoutDraft(input, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    const bedSofa = byId.get("bed_sofa_category")!;
    const bedTable = byId.get("bed_table_category")!;
    expect(bedTable.category).toBe("sofa");
    expect(bedTable.size).toEqual(bedSofa.size);
    expect(bedTable.assembly).toEqual(bedSofa.assembly);
    expect(bedTable.rotationYDegrees).toBe(bedSofa.rotationYDegrees);
    expect(bedTable.uncertain).toBe(true);
    expect(bedTable.notes).toContain("table 与已知身份 bed 不一致");

    const bookshelf = byId.get("bookshelf_table_category")!;
    expect(bookshelf.category).toBe("cabinet");
    expect(bookshelf.size).toEqual([0.9, 1.8, 0.35]);
    expect(bookshelf.uncertain).toBe(true);
    expect(bookshelf.notes).toContain("table 与已知身份 bookshelf 不一致");

    const unknown = byId.get("unknown_chair_category")!;
    expect(unknown.category).toBe("chair");
    expect(unknown.size).not.toEqual([2, 1.2, 2.2]);
    expect(input).toEqual(original);
  });

  it("uses canonical geometry for known identity conflicts and does not fall back to a generic unit box", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "mislabeled", name: "物件", semanticType: "table", category: "chair", bbox: [0.1, 0.1, 0.8, 0.8], confidence: 0.9, visibility: "visible" },
        { id: "identity_conflict", name: "大型基础类别物件", semanticType: "bed", category: "chair", bbox: [0.2, 0.1, 0.7, 0.8], confidence: 0.9, visibility: "visible" },
        { id: "prop_bed_conflict", name: "未知物件", semanticType: "bed", category: "prop", bbox: [0.3, 0.2, 0.6, 0.7], confidence: 0.9, visibility: "visible" },
        { id: "prop_legacy_context_conflict", name: "茶几上的未知物件", category: "prop", bbox: [0.32, 0.25, 0.5, 0.5], confidence: 0.9, visibility: "visible" },
        { id: "table_legacy_context", name: "茶几", category: "table", bbox: [0.35, 0.4, 0.65, 0.7], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const component = draft.components[0];
    const identityConflict = draft.components[1];
    expect(component.category).toBe("table");
    expect(component.size[1]).toBe(0.75);
    expect(component.uncertain).toBe(true);
    expect(component.notes).toContain("识别类别 chair 与已知身份 table 不一致");
    expect(component.semanticType).toBe("table");
    expect(component.assembly).toBeDefined();
    expect(identityConflict.category).toBe("sofa");
    expect(identityConflict.size).toEqual([2, 1.2, 2.2]);
    expect(identityConflict.assembly).toHaveLength(5);
    expect(identityConflict.notes).toContain("chair 与已知身份 bed 不一致");
    const propBedConflict = draft.components[2];
    expect(propBedConflict.category).toBe("sofa");
    expect(propBedConflict.uncertain).toBe(true);
    expect(propBedConflict.assembly).toHaveLength(5);
    expect(propBedConflict.size).toEqual([2, 1.2, 2.2]);
    expect(draft.components[3].category).toBe("prop");
    expect(draft.components[3].assembly).toEqual([{ primitive: "box", position: [0.5, 0.5, 0.5], size: [1, 1, 1] }]);
    expect(draft.components[4].category).toBe("table");
    expect(draft.components[4].assembly).toBeDefined();
  });

  it("accepts an exact bounded camera candidate and falls back when evidence is sparse", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const components: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `object_${index}`, name: "fixture object", category: "prop", primitive: "box",
      position: [x, 0, 0], size: [2, 1, 1], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = components.map((component) => ({ component, confidence: 0.95, bbox: projectedBox(component, camera, 1) }));
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceCamera(pairs, fallback, 1, components);
    expect(fit.rejectionReason).toBeNull();
    expect(fit.camera?.confidence).toBeGreaterThan(0);
    expect(fit.best).toBeLessThan(fit.before!);
    expect(cameraFitError(pairs, fit.camera!, 1)).toBeCloseTo(fit.best!, 8);
    const sparse = fitReferenceCamera(pairs.slice(0, 2), fallback, 1, components);
    expect(sparse.camera).toBe(fallback);
    expect(sparse.rejectionReason).toBe("insufficient-evidence");
  });

  it("maps upright, column and flat forms with aspect-aware dimensions", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        { id: "column", name: "柱体", semanticType: "pillar", bbox: [0.19, 0, 0.25, 0.72], confidence: 0.9, visibility: "visible" },
        { id: "upright", name: "竖立物件", category: "prop", semanticType: "statue", bbox: [0.66, 0.02, 0.84, 0.42], confidence: 0.9, visibility: "visible" },
        { id: "flat", name: "软垫", semanticType: "cushion", bbox: [0.21, 0.78, 0.51, 0.98], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const column = draft.components.find((component) => component.id === "column")!;
    const upright = draft.components.find((component) => component.id === "upright")!;
    const flat = draft.components.find((component) => component.id === "flat")!;
    expect(column.size[0]).toBe(column.size[2]);
    expect(column.size[1]).toBeGreaterThan(column.size[0] * 3);
    expect(upright.size[1]).toBeGreaterThan(1);
    expect(upright.size[1]).toBeGreaterThan(upright.size[2]);
    expect(flat.size[1]).toBe(0.08);
  });

  it("keeps coverings distinct from openings and places wall-mounted decor on non-bedroom walls", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "left_wall", kind: "wall", side: "image_left", bbox: [0, 0.05, 0.22, 0.92], confidence: 0.95 },
        { id: "back_wall", kind: "wall", side: "image_back", bbox: [0.2, 0.05, 0.8, 0.92], confidence: 0.95 },
      ],
      items: [
        { id: "curtain", name: "窗帘", semanticType: "curtain", category: "window", bbox: [0.3, 0.2, 0.55, 0.65], confidence: 0.92, visibility: "visible", contactWallSide: "image_back" },
        { id: "painting", name: "挂画", semanticType: "wall_art", bbox: [0.05, 0.18, 0.18, 0.42], confidence: 0.9, visibility: "visible", contactWallSide: "image_left" },
        { id: "mirror", name: "镜子", semanticType: "mirror", bbox: [0.62, 0.22, 0.76, 0.52], confidence: 0.9, visibility: "visible", placement: "wall_attached", contactWallSide: "image_back" },
        { id: "actual_window", name: "窗户", semanticType: "window", bbox: [0.42, 0.25, 0.62, 0.5], confidence: 0.94, visibility: "visible", placement: "wall_attached", contactWallSide: "image_back" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    const curtain = byId.get("curtain")!;
    const painting = byId.get("painting")!;
    const mirror = byId.get("mirror")!;
    const actualWindow = byId.get("actual_window")!;
    expect(curtain.category).toBe("prop");
    expect(curtain.size[2]).toBeLessThanOrEqual(0.12);
    expect(curtain.position[1]).toBeGreaterThan(0.5);
    expect(curtain.position[1] + curtain.size[1]).toBeLessThanOrEqual(2.8);
    expect(Math.abs(curtain.position[0]) + curtain.size[0] / 2).toBeLessThanOrEqual(3);
    expect(painting.category).toBe("prop");
    expect(painting.position[1]).toBeGreaterThan(0.5);
    expect(painting.position[0]).toBeGreaterThan(-3); // image-left wall; mounted inward.
    expect(mirror.position[1]).toBeGreaterThan(0.5);
    expect(actualWindow.category).toBe("window");
    expect(actualWindow.position[2]).toBe(-3); // true openings retain the wall plane.
    expect(draft.relations).toContainEqual(expect.objectContaining({ fromId: "curtain", toId: "back_wall", type: "attached_to" }));
    expect(draft.relations).toContainEqual(expect.objectContaining({ fromId: "painting", toId: "left_wall", type: "attached_to" }));
    expect(draft.validationWarnings ?? []).toContain("attachment_unresolved");
    expect(curtain.uncertain).toBe(true);
    expect(actualWindow.size[2]).toBeLessThanOrEqual(0.12);
  });

  it("clamps wall-mounted decor within the visible wall and stores its bottom height", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "left_wall", kind: "wall", side: "image_left", bbox: [0, 0.05, 0.22, 0.92], confidence: 0.95 }],
      items: [{ id: "curtain", name: "左侧窗帘", semanticType: "curtain", bbox: [0, 0.05, 0.12, 0.2], confidence: 0.9, visibility: "visible", placement: "wall_attached", contactWallSide: "image_left" }],
    }, source);
    const curtain = draft.components.find((component) => component.id === "curtain")!;
    expect(Math.abs(curtain.position[2]) + curtain.size[0] / 2).toBeLessThanOrEqual(3);
    expect(curtain.position[1]).toBeGreaterThan(0);
    expect(curtain.position[1] + curtain.size[1]).toBeLessThanOrEqual(2.8);
  });

  it("only rotates a high-confidence chair toward an explicit visible target and keeps its position", () => {
    const draft = imageObservationToLayoutDraft({
      items: [
        { id: "chair", name: "椅子", semanticType: "chair", bbox: [0.18, 0.4, 0.38, 0.82], confidence: 0.95, visibility: "visible", facingTowardId: "desk" },
        { id: "desk", name: "桌子", semanticType: "desk", bbox: [0.68, 0.4, 0.88, 0.72], confidence: 0.93, visibility: "visible" },
      ],
      surfaces: [],
    }, source);
    const chair = draft.components.find((component) => component.id === "chair")!;
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect(chair.rotationYDegrees).toBeCloseTo(Math.atan2(desk.position[0] - chair.position[0], desk.position[2] - chair.position[2]) * 180 / Math.PI, 5);
    expect(chair.position[0]).toBeCloseTo(-1.32, 8);
    expect(chair.position[1]).toBe(0);
    expect(chair.position[2]).toBeCloseTo(1.68, 8);
    expect(chair.uncertain).toBe(true);
    expect(draft.relations).toContainEqual({ fromId: "chair", toId: "desk", type: "faces", confidence: 0.93 });
  });

  it.each([
    ["missing", "absent", 0.95, "visible"],
    ["low confidence", "desk", 0.4, "visible"],
    ["occluded", "desk", 0.95, "partly_occluded"],
  ])("does not apply a %s facing target", (_label, targetId, targetConfidence, targetVisibility) => {
    const draft = imageObservationToLayoutDraft({
      items: [
        { id: "chair", name: "椅子", semanticType: "chair", bbox: [0.18, 0.4, 0.38, 0.82], confidence: 0.95, visibility: "visible", facingTowardId: targetId },
        { id: "desk", name: "桌子", semanticType: "desk", bbox: [0.68, 0.4, 0.88, 0.72], confidence: targetConfidence, visibility: targetVisibility },
      ],
      surfaces: [],
    }, source);
    const chair = draft.components.find((component) => component.id === "chair")!;
    expect(chair.rotationYDegrees).toBe(0);
    expect(chair.uncertain).toBe(true);
    expect(draft.relations ?? []).not.toContainEqual(expect.objectContaining({ fromId: "chair", type: "faces" }));
  });

  it("rejects cyclic facing relations and does not infer bed facing from target convention", () => {
    const cyclic = imageObservationToLayoutDraft({
      items: [
        { id: "chair_a", name: "椅子A", semanticType: "chair", bbox: [0.1, 0.4, 0.3, 0.82], confidence: 0.95, visibility: "visible", facingTowardId: "chair_b" },
        { id: "chair_b", name: "椅子B", semanticType: "chair", bbox: [0.7, 0.4, 0.9, 0.82], confidence: 0.95, visibility: "visible", facingTowardId: "chair_a" },
        { id: "bed", name: "床", semanticType: "bed", bbox: [0.4, 0.4, 0.6, 0.8], confidence: 0.95, visibility: "visible", facingTowardId: "chair_a" },
      ],
      surfaces: [],
    }, source);
    for (const id of ["chair_a", "chair_b", "bed"]) {
      expect(cyclic.components.find((component) => component.id === id)!.rotationYDegrees).toBe(0);
    }
    expect(cyclic.relations ?? []).not.toContainEqual(expect.objectContaining({ type: "faces" }));
    expect(cyclic.components.find((component) => component.id === "bed")?.uncertain).toBe(true);
  });

  it("keeps upright depth independent from bbox height and stable under small bbox-width changes", () => {
    const widths = [0.18, 0.19, 0.2, 0.21];
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        ...widths.map((right, index) => ({
          id: `buddha_${index}`,
          name: "佛像",
          semanticType: "buddha_statue",
          bbox: [0.5, 0.02, 0.5 + right, 0.42],
          confidence: 0.9,
          visibility: "visible",
        })),
        { id: "wide_vase", name: "花瓶", semanticType: "ceramic_vase", bbox: [0.1, 0.1, 0.44, 0.5], confidence: 0.9, visibility: "visible" },
        { id: "wide_lamp", name: "灯具", semanticType: "unknown_lamp_form", bbox: [0.5, 0.1, 0.9, 0.5], confidence: 0.9, visibility: "visible" },
        { id: "wide_unknown_a", name: "未知陈设甲", semanticType: "unknown_display", bbox: [0.05, 0.3, 0.65, 0.7], confidence: 0.8, visibility: "visible" },
        { id: "wide_unknown_b", name: "未知陈设乙", semanticType: "unclassified_prop", bbox: [0.3, 0.12, 0.88, 0.52], confidence: 0.8, visibility: "visible" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    const buddhas = widths.map((_, index) => byId.get(`buddha_${index}`)!);
    for (const statue of buddhas) {
      expect(statue.size[1]).toBeCloseTo(1.2);
      expect(statue.size[1]).toBeGreaterThan(statue.size[2]);
      expect(statue.size[2]).toBeLessThanOrEqual(1.2);
    }
    buddhas.forEach((statue, index) => expect(statue.size[0]).toBeCloseTo([0.96, 1.0133333333, 1.0666666667, 1.12][index]));
    expect(buddhas.map((statue) => statue.size[2])).toEqual([0.3, 0.3, 0.3, 0.3]);
    for (const id of ["wide_vase", "wide_lamp", "wide_unknown_a", "wide_unknown_b"]) {
      const item = byId.get(id)!;
      expect(item.size[1]).toBeCloseTo(id === "wide_vase" ? 0.55 : 2.4);
      expect(item.size[2]).toBeLessThanOrEqual(1.2);
      expect(item.size[1]).toBeGreaterThan(item.size[2]);
    }

    const landscape = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9, surfaces: [],
      items: [{ id: "landscape", name: "statue", semanticType: "statue", bbox: [0.4, 0.2, 0.6, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source).components[0];
    const portrait = imageObservationToLayoutDraft({
      imageAspectRatio: 9 / 16, surfaces: [],
      items: [{ id: "portrait", name: "statue", semanticType: "statue", bbox: [0.18, 0.2, 0.8122222222, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source).components[0];
    expect(portrait.size[0]).toBeCloseTo(landscape.size[0]);
    expect(portrait.size[1]).toBeCloseTo(landscape.size[1]);
    expect(portrait.size[2]).toBeCloseTo(landscape.size[2]);
  });

  it("keeps blankets, throws and tablecloths as supported flat textiles", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed", imageAspectRatio: 1,
      surfaces: [],
      items: [
        { id: "bed", name: "床", semanticType: "bed", bbox: [0.2, 0.25, 0.8, 0.75], confidence: 0.95, visibility: "visible" },
        { id: "throw_blanket", name: "毯子", semanticType: "throw_blanket", bbox: [0.3, 0.42, 0.55, 0.64], confidence: 0.9, visibility: "visible", supportId: "bed" },
        { id: "tablecloth", name: "桌布", semanticType: "tablecloth", bbox: [0.6, 0.42, 0.75, 0.58], confidence: 0.9, visibility: "visible", supportId: "bed" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    for (const id of ["throw_blanket", "tablecloth"]) {
      expect(byId.get(id)?.size[1]).toBe(0.08);
      expect(byId.get(id)?.supportComponentId).toBe("bed");
      expect(byId.get(id)?.position[1]).toBeCloseTo(0.576);
      expect(byId.get(id)?.notes).not.toContain("未按宽高比推断水平承载方向");
    }
  });

  it("uses the same furniture semantic profile for altar and small tables as for table dimensions", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        { id: "altar", name: "供桌", semanticType: "altar_table", bbox: [0.38, 0.42, 0.96, 0.82], confidence: 0.95, visibility: "visible" },
        { id: "stand", name: "小木几", semanticType: "small_table", bbox: [0.49, 0.62, 0.65, 0.82], confidence: 0.9, visibility: "visible" },
        { id: "dining", name: "餐桌", semanticType: "dining_table", bbox: [0.1, 0.4, 0.4, 0.65], confidence: 0.9, visibility: "visible" },
        { id: "garden", name: "户外桌", semanticType: "garden_table", bbox: [0.1, 0.4, 0.4, 0.65], confidence: 0.9, visibility: "visible" },
        { id: "bedside", name: "床头柜", semanticType: "bedside_table", bbox: [0.1, 0.4, 0.2, 0.6], confidence: 0.9, visibility: "visible" },
        { id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.4, 0.35, 0.5, 0.6], confidence: 0.9, visibility: "visible" },
        { id: "cloth", name: "桌布", semanticType: "tablecloth", bbox: [0.4, 0.6, 0.6, 0.7], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    for (const id of ["altar", "stand", "dining", "garden", "bedside"]) {
      const table = draft.components.find((component) => component.id === id)!;
      expect(table.category).toBe("table");
      expect(table.size[1]).toBe(0.75);
      expect(table.size[0]).toBeGreaterThan(0.25);
    }
    expect(draft.components.find((component) => component.id === "altar")?.size[0]).toBeCloseTo(3.48);
    expect(draft.components.find((component) => component.id === "stand")?.size[0]).toBeCloseTo(0.96);
    expect(draft.components.find((component) => component.id === "lamp")?.category).toBe("prop");
    expect(draft.components.find((component) => component.id === "cloth")?.size[1]).toBe(0.08);
  });

  it("does not infer a wide unknown prop is a horizontal support surface from bbox ratio alone", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [{ id: "tv", name: "横向电视", semanticType: "television", bbox: [0.2, 0.3, 0.8, 0.44], confidence: 0.9, visibility: "visible" }],
    }, source);
    const television = draft.components.find((component) => component.id === "tv")!;
    expect(television.size[1]).toBeGreaterThan(0.12);
    expect(television.uncertain).toBe(true);
    expect(television.notes).toContain("未按宽高比推断水平承载方向");
  });

  it("reports absolute initial overlap counts without camera anchors and excludes hidden objects", () => {
    const component = (id: string, visible = true): LayoutDraftComponent => ({
      id, name: id, category: "prop", primitive: "box", position: [0, 0, 0], size: [1, 1, 1],
      rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible,
    });
    const fallback = { projection: "perspective" as const, position: [0, 2, 8] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene([], fallback, 1, [component("visible_a"), component("visible_b"), component("hidden", false)]);

    expect(fit.rejectionReason).toBe("insufficient-evidence");
    expect(fit.collisionPairs).toEqual([expect.objectContaining({ firstId: "visible_a", secondId: "visible_b", classification: "hard", reason: "rendered-rigid-prism-penetration", penetrationMeters: 1 })]);
    expect(fit.physicalValidity?.initialCollisionCounts).toEqual({ totalCandidates: 1, hard: 1, review: 0, allowed: 0 });
    expect(fit.physicalValidity?.finalCollisionCounts).toEqual(fit.physicalValidity?.initialCollisionCounts);
  });

  it("uses shared upright semantic height priors across names and leaves unknown props image-scaled", () => {
    const draft = imageObservationToLayoutDraft({
      imageAspectRatio: 16 / 9,
      surfaces: [],
      items: [
        { id: "vase_a", name: "花瓶甲", semanticType: "vase", bbox: [0.1, 0.1, 0.2, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "vase_b", name: "decorative vessel", semanticType: "vase", bbox: [0.3, 0.1, 0.4, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "candlestick", name: "供桌烛具", semanticType: "candle_holder", bbox: [0.5, 0.1, 0.6, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "censer", name: "香薰器皿", semanticType: "incense_burner", bbox: [0.7, 0.1, 0.8, 0.55], confidence: 0.9, visibility: "visible" },
        { id: "unknown", name: "unclassified object", semanticType: "unclassified_prop", bbox: [0.1, 0.1, 0.2, 0.55], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    expect(byId.get("vase_a")?.size[1]).toBe(0.55);
    expect(byId.get("vase_b")?.size[1]).toBe(0.55);
    expect(byId.get("vase_a")?.size).toEqual(byId.get("vase_b")?.size);
    expect(byId.get("candlestick")?.size[1]).toBe(0.38);
    expect(byId.get("censer")?.size[1]).toBe(0.55);
    expect(byId.get("unknown")?.size[1]).toBeGreaterThan(byId.get("vase_a")!.size[1]);
  });

  it("carries support and partOf components with their fitted parent", () => {
    const parent: LayoutDraftComponent = { id: "table", name: "table", category: "table", primitive: "box", position: [1, 0, 2], size: [2, 0.8, 1], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true };
    const supported: LayoutDraftComponent = { id: "statue", name: "statue", category: "prop", primitive: "box", position: [1.2, 0.8, 2.1], size: [0.4, 1, 0.4], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true, supportComponentId: "table" };
    const part: LayoutDraftComponent = { id: "detail", name: "detail", category: "prop", primitive: "box", position: [1.3, 0.2, 2.2], size: [0.2, 0.2, 0.2], rotationYDegrees: 0, confidence: 0.8, uncertain: true, visible: true, partOfComponentId: "table" };
    const movedParent = { ...parent, position: [1.6, 0, 1.5] as [number, number, number] };
    const carried = carryFittedParentMotion([movedParent], [parent, supported, part]);
    const carriedStatue = carried.components.find((component) => component.id === "statue")!;
    expect(carriedStatue.position[0]).toBeCloseTo(1.8);
    expect(carriedStatue.position[1]).toBeCloseTo(0.8);
    expect(carriedStatue.position[2]).toBeCloseTo(1.6);
    expect(carried.components.find((component) => component.id === "detail")?.position[0]).toBeCloseTo(1.9);
    expect(carried.components.find((component) => component.id === "detail")?.position[2]).toBeCloseTo(1.7);
    expect(carried.movedComponentCount).toBe(3);
  });

  it("uses camera refinement before making estimated ground placements", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const truth: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `joint_${index}`, name: "fixture prop", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [1, 1, 1], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const priors = truth.map((component) => ({
      ...component,
      position: [component.position[0] + 0.35, 0, component.position[2] + 0.35] as [number, number, number],
    }));
    const pairs: CameraFitPair[] = truth.map((component, index) => ({ component: priors[index], confidence: 0.95, bbox: projectedBox(component, camera, 1), onGround: true }));
    const floor: LayoutDraftComponent = { id: "ground", name: "floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [6, 0.02, 6], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...priors, floor]);
    expect(fit.rejectionReason).toBeNull();
    expect(fit.movedCount).toBe(0);
    expect(fit.components).toEqual([]);
    expect(fit.physicalValidity?.cameraOutsideGeometry).toBe(true);
    expect(fit.best).toBeLessThan(fit.before!);
  });

  it("jointly fits three ground objects from an independent Three.js camera truth", () => {
    const aspect = 1.35;
    const truthCamera = new PerspectiveCamera(52, aspect, 0.01, 100);
    truthCamera.position.set(0.35, 3.1, 8.2);
    truthCamera.lookAt(-0.12, 0.45, 0.1);
    truthCamera.updateProjectionMatrix();
    truthCamera.updateMatrixWorld(true);
    const trueFitCamera = {
      position: [truthCamera.position.x, truthCamera.position.y, truthCamera.position.z] as [number, number, number],
      target: [-0.12, 0.45, 0.1] as [number, number, number],
      fov: 52,
      projection: "perspective" as const,
      confidence: 0.9,
      source: "estimated" as const,
    };
    const truth: LayoutDraftComponent[] = [
      { id: "truth_left", name: "left table", category: "table", primitive: "box", position: [-1.8, 0, 0.15], size: [1.1, 0.8, 0.75], rotationYDegrees: 8, confidence: 0.96, uncertain: false, visible: true },
      { id: "truth_center", name: "center chair", category: "chair", primitive: "box", position: [0.1, 0, -0.35], size: [0.65, 1.25, 0.62], rotationYDegrees: -6, confidence: 0.96, uncertain: false, visible: true },
      { id: "truth_right", name: "right cabinet", category: "cabinet", primitive: "box", position: [2.05, 0, -0.1], size: [0.9, 1.7, 0.62], rotationYDegrees: 3, confidence: 0.96, uncertain: false, visible: true },
    ];
    const perturbations: [number, number][] = [[0.35, 0.2], [-0.28, 0.42], [0.15, -0.3]];
    const priors = truth.map((component, index) => ({
      ...component,
      position: [component.position[0] + perturbations[index][0], component.position[1], component.position[2] + perturbations[index][1]] as [number, number, number],
      size: [component.size[0] * [1.2, 0.82, 1.12][index], component.size[1] * [0.9, 1.18, 0.88][index], component.size[2] * [0.78, 1.24, 0.9][index]] as [number, number, number],
    }));
    const imagePoint = (x: number, z: number) => projectedByThree(new Vector3(x, 0, z), truthCamera);
    const pairs: CameraFitPair[] = truth.map((component, index) => ({
      component: priors[index], confidence: 0.96, bbox: projectedBoxByThree(component, truthCamera), onGround: true,
      groundContacts: [{ point: imagePoint(component.position[0], component.position[2]), kind: "center", visibility: "visible", confidence: 0.96 }],
      groundCamera: trueFitCamera,
    }));
    const floor: LayoutDraftComponent = { id: "truth_floor", name: "floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [8, 0.02, 7], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const pairwiseDistanceError = (components: LayoutDraftComponent[]) => {
      const byId = new Map(components.map((component) => [component.id, component]));
      let sum = 0, count = 0;
      for (let i = 0; i < truth.length; i += 1) for (let j = i + 1; j < truth.length; j += 1) {
        const left = byId.get(truth[i].id)!, right = byId.get(truth[j].id)!;
        const expected = Math.hypot(truth[i].position[0] - truth[j].position[0], truth[i].position[2] - truth[j].position[2]);
        const observed = Math.hypot(left.position[0] - right.position[0], left.position[2] - right.position[2]);
        sum += Math.pow(observed / expected - 1, 2); count += 1;
      }
      return Math.sqrt(sum / count);
    };
    const priorError = pairwiseDistanceError(priors);
    const fit = fitReferenceScene(pairs, fallback, aspect, [...priors, floor]);
    const fittedById = new Map(fit.components.map((component) => [component.id, component]));
    const fittedError = pairwiseDistanceError(truth.map((component) => fittedById.get(component.id) ?? priors.find(({ id }) => id === component.id)!));
    const footprintRatioError = (components: LayoutDraftComponent[]) => Math.sqrt(components.reduce((sum, component, index) => {
      const fitted = components.find(({ id }) => id === truth[index].id)!;
      const expectedRatio = truth[index].size[0] / truth[index].size[2];
      return sum + Math.pow(Math.log((fitted.size[0] / fitted.size[2]) / expectedRatio), 2);
    }, 0) / truth.length);
    const priorRatioError = footprintRatioError(priors);
    const fittedRatioError = footprintRatioError(truth.map((component) => fittedById.get(component.id) ?? priors.find(({ id }) => id === component.id)!));
    expect(fit.candidateCount).toBeGreaterThan(0);
    expect(fit.camera).not.toBe(fallback);
    expect(fittedError).toBeLessThan(priorError);
    expect(fittedRatioError).toBeLessThan(priorRatioError);
    expect(fit.physicalValidity?.hardCollisionCount).toBe(0);
  });

  it("recovers a known camera with continuous position, target, and FOV refinement without moving objects", () => {
    const camera = { position: [0.35, 2.15, 7.4] as [number, number, number], target: [-0.25, 0.85, -0.4] as [number, number, number], fov: 57 };
    const truth: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `camera_truth_${index}`, name: "known fixture object", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [0.8, 1.4, 0.7], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = truth.map((component) => ({ component, confidence: 0.98, bbox: projectedBox(component, camera, 1.4) }));
    const floor: LayoutDraftComponent = { id: "known_ground", name: "ground", category: "ground", primitive: "box", position: [0, 0, 0], size: [8, 0.02, 8], rotationYDegrees: 0, confidence: 0.98, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1.4, [...truth, floor]);

    expect(fit.rejectionReason).toBeNull();
    expect(fit.best).toBeLessThan(0.01);
    expect(fit.candidateCount).toBeGreaterThan(0);
    expect(fit.candidateCount).toBeLessThanOrEqual(16);
    expect(fit.camera).not.toBe(fallback);
    expect(fit.components).toEqual([]);
    expect(fit.physicalValidity?.cameraOutsideGeometry).toBe(true);
    expect(fit.physicalValidity?.hardCollisionCount).toBe(0);
    const breakdown = cameraFitBreakdown(pairs, fit.camera!, 1.4);
    expect(breakdown.pairs).toHaveLength(pairs.length);
    expect(breakdown.pairs.map((item) => item.id)).toEqual(truth.map((component) => component.id));
    expect(breakdown.pairs.reduce((sum, item) => sum + item.weightedContribution, 0)).toBeCloseTo(breakdown.error, 8);
    expect(breakdown.pairs.every((item) => item.observedSize.every((size) => size > 0) && item.predictedSize.every((size) => size > 0))).toBe(true);
  });

  it("scores the rendered medium-confidence concave assembly prism vertices and labels conservative fallbacks", () => {
    const sofa: LayoutDraftComponent = {
      id: "concave_sofa", name: "sofa", category: "sofa", primitive: "box",
      position: [0, 0, 0], size: [2.4, 1.1, 1.6], rotationYDegrees: 19,
      confidence: 0.9, uncertain: false, visible: true,
      assembly: [{ primitive: "box", position: [0.5, 0.5, 0.5], size: [1, 1, 1] }],
      groundFootprint: [{ confidence: 0.65, outer: [[0, 0], [1, 0], [1, 0.4], [0.4, 0.4], [0.4, 1], [0, 1]] }],
    };
    const camera = { position: [0.2, 2.8, 7] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 52 };
    const pair: CameraFitPair = { component: sofa, confidence: 0.9, bbox: [0, 0, 1, 1] };
    const scored = cameraFitBreakdown([pair], camera, 1.5).pairs[0];
    const fullBox = projectedBox({ ...sofa, groundFootprint: undefined }, camera, 1.5);
    expect(scored.projectionGeometry).toBe("observed-assembly-prisms");
    expect(scored.predictedSize[0]).toBeLessThan(fullBox[2] - fullBox[0]);
    expect(scored.predictedSize[1]).toBeLessThan(fullBox[3] - fullBox[1]);
    expect(cameraWorldCorners(sofa).length).toBeGreaterThan(8);

    const curved = { ...sofa, id: "curved_proxy", assembly: [{ primitive: "sphere" as const, position: [0.5, 0.5, 0.5] as [number, number, number], size: [1, 1, 1] as [number, number, number] }] };
    const fallback = cameraFitBreakdown([{ ...pair, component: curved }], camera, 1.5).pairs[0];
    expect(fallback.projectionGeometry).toBe("component-bounds-fallback");
  });

  it("uses supported items as camera anchors but excludes unknown and hanging placements from ground eligibility", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open",
      imageAspectRatio: 1.5,
      surfaces: [{ id: "floor_main", kind: "floor", side: "floor", bbox: [0.05, 0.6, 0.95, 0.98], confidence: 0.95, visibility: "visible" }],
      items: [
        { id: "table", name: "桌", semanticType: "table", category: "table", bbox: [0.1, 0.4, 0.4, 0.8], confidence: 0.95, visibility: "visible", placement: "floor", supportId: "floor_main" },
        { id: "tabletop_vase", name: "桌上容器", semanticType: "container", category: "prop", bbox: [0.18, 0.2, 0.3, 0.42], confidence: 0.95, visibility: "visible", placement: "supported", supportId: "table" },
        { id: "rug", name: "地面覆盖物", semanticType: "rug", category: "prop", bbox: [0.35, 0.65, 0.68, 0.9], confidence: 0.95, visibility: "visible", placement: "floor", supportId: "floor_main" },
        { id: "armchair", name: "扶手椅", semanticType: "chair", category: "chair", bbox: [0.38, 0.48, 0.56, 0.82], confidence: 0.95, visibility: "visible", placement: "supported", supportId: "rug" },
        { id: "sofa", name: "沙发", semanticType: "sofa", category: "sofa", bbox: [0.42, 0.4, 0.75, 0.8], confidence: 0.95, visibility: "visible", placement: "floor" },
        { id: "cabinet", name: "柜", semanticType: "cabinet", category: "cabinet", bbox: [0.76, 0.35, 0.96, 0.8], confidence: 0.95, visibility: "visible", placement: "floor" },
        { id: "hanging_light", name: "悬挂物", semanticType: "uncatalogued_light", category: "prop", bbox: [0.45, 0.02, 0.55, 0.2], confidence: 0.95, visibility: "visible", placement: "wall_attached" },
        { id: "unknown_object", name: "未知物", semanticType: "prop", category: "prop", bbox: [0.02, 0.45, 0.1, 0.65], confidence: 0.95, visibility: "visible", placement: "unknown" },
      ],
    }, source, { imageAspectRatio: 1.5 });
    const pairs = draft.referenceCamera?.fitDiagnostics?.pairDiagnostics ?? [];
    expect(pairs.map(({ id }) => id)).toContain("tabletop_vase");
    expect(pairs.map(({ id }) => id)).toContain("armchair");
    expect(pairs.map(({ id }) => id)).not.toContain("hanging_light");
    expect(pairs.map(({ id }) => id)).not.toContain("unknown_object");
    expect(draft.components.find(({ id }) => id === "tabletop_vase")?.supportComponentId).toBe("table");
    expect(draft.referenceCamera?.fitDiagnostics?.movedGroundItems).toBe(0);
  });

  it("keeps floor placement when a non-ground support edge contradicts it and excludes that item from camera fitting", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      imageAspectRatio: 1.5,
      surfaces: [],
      items: [
        { id: "bed_main", name: "bed", semanticType: "bed", category: "sofa", bbox: [0.25, 0.25, 0.75, 0.7], confidence: 0.95, visibility: "visible", placement: "floor" },
        { id: "bed_bench", name: "bench", semanticType: "bench", category: "sofa", bbox: [0.3, 0.68, 0.7, 0.85], confidence: 0.95, visibility: "visible", placement: "floor", supportId: "bed_main" },
        { id: "rug", name: "rug", semanticType: "rug", category: "prop", bbox: [0.15, 0.68, 0.85, 0.9], confidence: 0.9, visibility: "visible", placement: "floor" },
        { id: "lamp", name: "lamp", semanticType: "table_lamp", category: "prop", bbox: [0.4, 0.2, 0.5, 0.35], confidence: 0.9, visibility: "visible", placement: "supported", supportId: "rug" },
      ],
    }, source, { imageAspectRatio: 1.5 });
    const bench = draft.components.find(({ id }) => id === "bed_bench")!;
    const lamp = draft.components.find(({ id }) => id === "lamp")!;
    const pairs = draft.referenceCamera?.fitDiagnostics?.pairDiagnostics ?? [];
    expect(bench.position[1]).toBe(0);
    expect(bench.supportComponentId).toBeUndefined();
    expect(bench.uncertain).toBe(true);
    expect(bench.notes).toContain("floor placement 和非地面 supportId=bed_main");
    expect(draft.relations?.some(({ fromId, toId, type }) => fromId === "bed_bench" && toId === "bed_main" && type === "supports")).toBe(false);
    expect(pairs.map(({ id }) => id)).not.toContain("bed_bench");
    expect(lamp.supportComponentId).toBe("rug");
    expect(pairs.map(({ id }) => id)).toContain("lamp");
  });

  it("accepts cabinet geometry for nightstands without accepting unrelated semantic category conflicts", () => {
    const draft = imageObservationToLayoutDraft({
      surfaces: [],
      items: [
        { id: "nightstand", name: "床头柜", semanticType: "nightstand", category: "cabinet", bbox: [0.1, 0.2, 0.3, 0.7], confidence: 0.9, visibility: "visible", placement: "floor" },
        { id: "bad_nightstand", name: "wrong geometry", semanticType: "nightstand", category: "sofa", bbox: [0.6, 0.2, 0.9, 0.7], confidence: 0.9, visibility: "visible", placement: "floor" },
      ],
    }, source);
    const compatible = draft.components.find(({ id }) => id === "nightstand")!;
    const incompatible = draft.components.find(({ id }) => id === "bad_nightstand")!;
    expect(compatible.category).toBe("cabinet");
    expect(compatible.size).toEqual([0.5, 0.55, 0.4]);
    expect(compatible.assembly?.length).toBeGreaterThan(1);
    expect(compatible.notes).not.toContain("基础几何类别与语义身份提示冲突");
    expect(incompatible.uncertain).toBe(true);
    expect(incompatible.category).toBe("table");
    expect(incompatible.size).toEqual(compatible.size);
    expect(incompatible.notes).toContain("识别类别 sofa 与已知身份 nightstand 不一致");
    expect(incompatible.assembly).toEqual(compatible.assembly);
  });

  it("rejects camera and object fits that reverse confident, separated image order", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const truth: LayoutDraftComponent[] = [-2, 0, 2].map((x, index) => ({
      id: `ordered_${index}`, name: "major prop", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [0.6, 1, 0.6], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const reversed = truth.map((component, index) => ({ ...component, position: [-truth[index].position[0], 0, -0.25] as [number, number, number] }));
    const pairs: CameraFitPair[] = truth.map((component, index) => ({ component: reversed[index], confidence: 0.95, bbox: projectedBox(component, camera, 1), onGround: true }));
    const floor: LayoutDraftComponent = { id: "ground", name: "floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [6, 0.02, 6], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...reversed, floor]);
    expect(fit.rejectionReason).toBe("no-safe-candidate");
    expect(fit.components).toEqual([]);
  });

  it("returns footprint initialization failures when every footprint camera seed is unsafe", () => {
    const camera = { position: [0, 2, 8] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50 };
    const components: LayoutDraftComponent[] = [-1.5, 0, 1.5].map((x, index) => ({
      id: `unsafe_footprint_${index}`, name: "ground object", category: "table", primitive: "box",
      position: [x, 0, 0] as [number, number, number], size: [0.9, 0.8, 0.8], rotationYDegrees: 0,
      confidence: 0.95, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = components.map((component) => ({
      component, confidence: 0.95, bbox: [0.1, 0.1, 0.9, 0.9], onGround: true,
      groundFootprints: [{ outer: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]], visibility: "visible", confidence: 0.95 }],
    }));
    const floor: LayoutDraftComponent = { id: "unsafe_floor", name: "floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [8, 0.02, 8], rotationYDegrees: 0, confidence: 0.9, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, ...camera, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...components, floor]);
    expect(fit.rejectionReason).toBe("no-safe-candidate");
    expect(fit.spatialEvidenceTrace?.failedInitializationById.length).toBeGreaterThan(0);
  });

  it("does not reject a fitted layout for extending beyond an estimated ground rectangle", () => {
    const camera = { position: [0, 1.6, 6.6] as [number, number, number], target: [0, 1.6, 0] as [number, number, number], fov: 75 };
    const truth: LayoutDraftComponent[] = [-3.35, 0, 3.35].map((x, index) => ({
      id: `edge_${index}`, name: "visible prop", category: "prop", primitive: "box",
      position: [x, 0, -0.25], size: [0.5, 1, 0.5], rotationYDegrees: 0, confidence: 0.95, uncertain: false, visible: true,
    }));
    const pairs: CameraFitPair[] = truth.map((component) => ({ component, confidence: 0.95, bbox: projectedBox(component, camera, 1), onGround: true }));
    const estimatedFloor: LayoutDraftComponent = { id: "ground", name: "detected floor", category: "ground", primitive: "box", position: [0, 0, 0], size: [6, 0.02, 6], rotationYDegrees: 0, confidence: 0.99, uncertain: false, visible: true };
    const fallback = { projection: "perspective" as const, position: [0, 2.2, 10] as [number, number, number], target: [0, 0.5, 0] as [number, number, number], fov: 50, confidence: 0, source: "bounds-fallback" as const };
    const fit = fitReferenceScene(pairs, fallback, 1, [...truth, estimatedFloor]);
    expect(fit.camera).not.toBe(fallback);
    expect(fit.physicalValidity?.withinRoom).toBe(false); // diagnostic only; the ground bbox is not a physical room boundary.
    expect(fit.physicalValidity?.roomBoundaryViolations.length).toBeGreaterThan(0);
    expect(fit.best).toBeLessThanOrEqual(0.22);
  });

  it.each([
    ["image_right", -90, 1],
    ["image_left", 90, -1],
  ] as const)("anchors a local -Z bed head to %s and mirrors yaw", (side, yaw, xSign) => {
    const draft = imageObservationToLayoutDraft(bedObservation(side), source, { draftId: "bed_" + side });
    const bed = draft.components.find((component) => component.id === "bed")!;

    expect(bed.rotationYDegrees).toBe(yaw);
    expect(Math.sign(bed.position[0])).toBe(xSign);
    expect(bed.position[0] + Math.sign(bed.position[0]) * bed.size[2] / 2).toBeCloseTo(xSign * 2.9);
    expect(bed.uncertain).toBe(true); // image bbox cannot fix depth along the wall.
    expect(bed.size[1]).toBe(1.2); // parent bounds include the raised headboard.
    expect(bed.appearance?.color).toBe("#F5F0E6");
    expect(bed.assembly).toHaveLength(5);
    for (const part of bed.assembly ?? []) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(part.position[axis] - part.size[axis] / 2).toBeGreaterThanOrEqual(0);
        expect(part.position[axis] + part.size[axis] / 2).toBeLessThanOrEqual(1);
      }
    }
    expect(draft.components.some((component) => component.id === "headboard")).toBe(false);
    expect(draft.observations?.some((observation) => observation.componentId === "bed" && observation.evidence?.includes("子部件"))).toBe(true);
    expect(draft.relations).toContainEqual({ fromId: "bed", toId: "anchor_wall", type: "head_at", confidence: 0.95 });
    const camera = draft.referenceCamera!;
    expect(camera).toMatchObject({ source: "bounds-fallback", imageAspectRatio: 1.5 });
    expect(camera.position[2]).toBeGreaterThan(camera.target[2]); // canonical camera faces from +Z toward -Z.
    expect(draft.validationWarnings ?? []).not.toContain("head_at_geometry_conflict");
  });

  it("anchors a bed head to the back wall at yaw zero", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.55], confidence: 0.9 }],
      items: [{ id: "bed", name: "床", semanticType: "bed", bbox: [0.25, 0.35, 0.8, 0.65], confidence: 0.9, visibility: "visible", againstSurfaceId: "back_wall" }],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    expect(bed.rotationYDegrees).toBe(0);
    expect(bed.position[2] - bed.size[2] / 2).toBeCloseTo(-2.9);
  });

  it("keeps floor furniture in the observed front-to-back order across wall and floor anchors", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "floor", kind: "floor", side: "floor", bbox: [0, 0.55, 1, 1], confidence: 0.98 },
        { id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0, 1, 0.62], confidence: 0.9 },
      ],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: [0.22, 0.38, 0.78, 0.65], confidence: 0.98, visibility: "visible", contactWallSide: "image_right" },
        { id: "rug", name: "rug", semanticType: "rug", bbox: [0.3, 0.6, 0.8, 0.73], confidence: 0.95, visibility: "visible", supportId: "floor" },
        { id: "desk", name: "desk", semanticType: "desk", bbox: [0.84, 0.5, 1, 0.68], confidence: 0.9, visibility: "partly_occluded", contactWallSide: "image_right" },
      ],
    }, source);
    const byId = new Map(draft.components.map((component) => [component.id, component]));
    const bed = byId.get("bed")!;
    const rug = byId.get("rug")!;
    const desk = byId.get("desk")!;
    // Smaller Z is farther from the camera. The fixture's bbox bottoms order these as bed, desk, rug.
    expect(bed.position[2]).toBeLessThan(desk.position[2]);
    expect(desk.position[2]).toBeLessThan(rug.position[2]);
    expect(bed.position[2]).toBeLessThan(0);
    expect(rug.position[2]).toBeLessThan(0);
    expect(desk.uncertain).toBe(true); // partially occluded footprint stays an estimate.
  });

  it("maps explicit contact wall side and retains rear feature as evidence", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 }],
      items: [{
        id: "bed", name: "床", semanticType: "bed", bbox: [0.2, 0.35, 0.9, 0.7], confidence: 0.9,
        visibility: "visible", contactWallSide: "image_right", rearFeature: { name: "床头板", bbox: [0.78, 0.35, 0.9, 0.55] }, bodyExtendsToward: "image_left",
      }],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    expect(bed.rotationYDegrees).toBe(-90);
    expect(draft.relations).toContainEqual({ fromId: "bed", toId: "right_wall", type: "adjacent_to", confidence: 0.9 });
    expect(bed.notes).toContain("床头板");
    expect(bed.uncertain).toBe(true);
  });

  it.each([
    ["image_left", 90],
    ["image_right", -90],
    ["image_back", 0],
  ] as const)("uses an explicit headboard contact as the bed rear direction for %s", (side, yaw) => {
    const wall = side === "image_left" ? { id: "left", kind: "wall", side, bbox: [0, 0.2, 0.22, 0.7] }
      : side === "image_right" ? { id: "right", kind: "wall", side, bbox: [0.78, 0.2, 1, 0.7] }
        : { id: "back", kind: "wall", side, bbox: [0, 0.1, 1, 0.55] };
    const parentBox = [0.2, 0.35, 0.8, 0.7];
    const childBox = side === "image_left" ? [0.2, 0.4, 0.34, 0.58]
      : side === "image_right" ? [0.66, 0.4, 0.8, 0.58]
        : [0.4, 0.35, 0.6, 0.48];
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed", surfaces: [{ ...wall, confidence: 0.95 }],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: parentBox, confidence: 0.95, visibility: "visible", contactWallSide: "image_back" },
        { id: "headboard", name: "headboard", semanticType: "headboard", bbox: childBox, confidence: 0.92, visibility: "visible", contactWallSide: side, partOfId: "bed" },
      ],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    expect(bed.rotationYDegrees).toBe(yaw);
    expect(bed.notes).toContain("父普通接墙仅表示接触");
    expect(draft.relations).toContainEqual({ fromId: "bed", toId: wall.id, type: "head_at", confidence: 0.95 });
    expect(draft.observations?.some((observation) => observation.componentId === "bed" && observation.evidence?.includes("接触"))).toBe(true);
  });

  it("uses a folded visible backrest as the parent orientation constraint without duplicate geometry", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "back", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.55], confidence: 0.9 },
        { id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 },
      ],
      items: [
        { id: "sofa", name: "sofa", semanticType: "sofa", bbox: [0.2, 0.35, 0.78, 0.7], confidence: 0.9, visibility: "visible", contactWallSide: "image_back" },
        { id: "backrest", name: "backrest", semanticType: "backrest", bbox: [0.68, 0.4, 0.78, 0.6], confidence: 0.9, visibility: "visible", contactWallSide: "image_right", partOfId: "sofa" },
      ],
    }, source);
    expect(draft.components.find((component) => component.id === "sofa")?.rotationYDegrees).toBe(-90);
    expect(draft.components.find((component) => component.id === "backrest")).toBeUndefined();
    expect(draft.relations).toContainEqual({ fromId: "sofa", toId: "right", type: "adjacent_to", confidence: 0.9 });
  });

  it("does not anchor a parent when rear parts conflict or parent rear evidence disagrees", () => {
    const base = {
      spaceType: "enclosed",
      surfaces: [
        { id: "back", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.55], confidence: 0.9 },
        { id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 },
      ],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: [0.2, 0.35, 0.78, 0.7], confidence: 0.9, visibility: "visible", contactWallSide: "image_back" },
        { id: "headboard-right", name: "headboard", semanticType: "headboard", bbox: [0.68, 0.4, 0.78, 0.6], confidence: 0.9, visibility: "visible", contactWallSide: "image_right", partOfId: "bed" },
        { id: "headboard-back", name: "headboard", semanticType: "headboard", bbox: [0.4, 0.35, 0.58, 0.48], confidence: 0.9, visibility: "visible", contactWallSide: "image_back", partOfId: "bed" },
      ],
    };
    const conflictingParts = imageObservationToLayoutDraft(base, source);
    const conflictedBed = conflictingParts.components.find((component) => component.id === "bed")!;
    expect(conflictedBed.uncertain).toBe(true);
    expect(conflictedBed.notes).toContain("与父级显式后侧方向证据冲突");
    expect(conflictingParts.observations?.some((observation) => observation.componentId === "bed" && observation.state === "ambiguous")).toBe(true);

    const disagreeingParent = imageObservationToLayoutDraft({
      ...base,
      items: [base.items[0], base.items[1], { ...base.items[2], contactWallSide: "image_right", bbox: [0.68, 0.4, 0.78, 0.6] }],
    }, source);
    expect(disagreeingParent.components.find((component) => component.id === "bed")?.uncertain).toBe(true);

    const rearFeatureConflict = imageObservationToLayoutDraft({
      ...base,
      items: [
        { ...base.items[0], rearFeature: { name: "rear panel", bbox: [0.22, 0.4, 0.34, 0.58] } },
        base.items[1],
      ],
    }, source);
    expect(rearFeatureConflict.components.find((component) => component.id === "bed")?.notes).toContain("未据此锚定");
  });

  it("does not let low-confidence or ambiguous rear parts determine parent yaw", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.95 }],
      items: [
        { id: "bed", name: "bed", semanticType: "bed", bbox: [0.2, 0.35, 0.78, 0.7], confidence: 0.9, visibility: "visible" },
        { id: "headboard", name: "headboard", semanticType: "headboard", bbox: [0.68, 0.4, 0.78, 0.6], confidence: 0.5, visibility: "visible", contactWallSide: "image_right", partOfId: "bed" },
      ],
    }, source);
    expect(draft.components.find((component) => component.id === "bed")?.rotationYDegrees).toBe(0);
  });

  it.each(["unknown", "none"] as const)("does not fall back to a legacy wall id for explicit %s", (contactWallSide) => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 }],
      items: [{ id: "desk", name: "桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9,
        visibility: "visible", contactWallSide, againstSurfaceId: "right_wall" }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect((draft.relations ?? []).some((relation) => relation.toId === "right_wall")).toBe(false);
    expect(desk.uncertain).toBe(true);
    expect(desk.notes).toContain("新旧墙面关系冲突");
  });

  it("does not anchor a new side that conflicts with a legacy wall ID", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.2, 1, 0.7], confidence: 0.9 },
        { id: "right_wall", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.7], confidence: 0.9 },
      ],
      items: [{ id: "desk", name: "桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9,
        visibility: "visible", contactWallSide: "image_right", againstSurfaceId: "back_wall" }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect((draft.relations ?? []).some((relation) => relation.toId === "back_wall" || relation.toId === "right_wall")).toBe(false);
    expect(desk.uncertain).toBe(true);
    expect(desk.notes).toContain("新旧墙面关系冲突");
  });

  it("normalizes color and appearance.color without copying material properties", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [], items: [{ id: "desk", name: "桌", semanticType: "desk", bbox: [0.3, 0.3, 0.7, 0.7], confidence: 0.9, visibility: "visible", appearance: { color: "#abcdef", roughness: 0.3 } }],
    }, source);
    expect(draft.components.find((component) => component.id === "desk")?.appearance?.color).toBe("#ABCDEF");
    expect(draft.components.find((component) => component.id === "desk")?.appearance?.roughness).toBeUndefined();
  });

  it.each([
    ["image_right", -90, 1],
    ["image_left", 90, -1],
  ] as const)("orients a wall-mounted opening toward the room for %s", (side, yaw, xSign) => {
    const right = side === "image_right";
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "side_wall", kind: "wall", side, bbox: right ? [0.78, 0.2, 1, 0.64] : [0, 0.2, 0.22, 0.64], confidence: 0.95 }],
      items: [{
        id: "window", name: "窗", semanticType: "window", bbox: right ? [0.84, 0.32, 0.96, 0.5] : [0.04, 0.32, 0.16, 0.5],
        confidence: 0.9, visibility: "visible", againstSurfaceId: "side_wall",
      }],
    }, source);
    const window = draft.components.find((component) => component.id === "window")!;
    expect(window.rotationYDegrees).toBe(yaw);
    expect(getLayoutComponentRotationYDegrees(window)).toBe(yaw);
    expect(Math.sign(window.position[0])).toBe(xSign);
    expect(draft.validationWarnings ?? []).not.toContain("attachment_geometry_conflict");
  });

  it("maps opening height from the actual top edge of the observed wall bbox", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.2, 1, 0.8], confidence: 0.95 }],
      items: [
        { id: "window_top", name: "上窗", semanticType: "window", bbox: [0.3, 0.3, 0.5, 0.4], confidence: 0.9, visibility: "visible", againstSurfaceId: "back_wall" },
        { id: "window_bottom", name: "下窗", semanticType: "window", bbox: [0.3, 0.6, 0.5, 0.7], confidence: 0.9, visibility: "visible", againstSurfaceId: "back_wall" },
      ],
    }, source);
    const top = draft.components.find((component) => component.id === "window_top")!;
    const bottom = draft.components.find((component) => component.id === "window_bottom")!;
    expect(top.position[1]).toBeCloseTo(1.3); // schema keeps the opening inside the 2.8m wall top.
    expect(bottom.position[1]).toBe(0);
    expect(top.position[1]).toBeGreaterThan(bottom.position[1]);
  });

  it("preserves a non-bedroom outdoor wall anchor without inventing the other walls", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "outdoor",
      surfaces: [{ id: "back_facade", kind: "wall", side: "image_back", bbox: [0, 0.2, 1, 0.58], confidence: 0.9 }],
      items: [{
        id: "window", name: "窗", semanticType: "window", bbox: [0.4, 0.28, 0.6, 0.48], confidence: 0.9,
        visibility: "visible", againstSurfaceId: "back_facade", mainColor: "#ABCDEF",
      }],
    }, source);

    expect(draft.components.filter((component) => component.category === "wall")).toHaveLength(1);
    expect(draft.components.find((component) => component.id === "window")).toMatchObject({
      position: [expect.any(Number), expect.any(Number), expect.any(Number)], rotationYDegrees: 0,
      appearance: { color: "#ABCDEF" },
    });
    const window = draft.components.find((component) => component.id === "window")!;
    expect(window.position[1] + window.size[1]).toBeLessThanOrEqual(2.8);
    expect(draft.spaceType).toBe("outdoor");
  });

  it("keeps observed enclosed walls on one shared room footprint with continuous corners", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "back", kind: "wall", side: "image_back", bbox: [0.2, 0.2, 0.78, 0.58], confidence: 0.9 },
        { id: "left", kind: "wall", side: "image_left", bbox: [0, 0.2, 0.2, 0.58], confidence: 0.8 },
        { id: "right", kind: "wall", side: "image_right", bbox: [0.78, 0.2, 1, 0.58], confidence: 0.8 },
      ],
      items: [],
    }, source);
    const walls = draft.components.filter((component) => component.category === "wall");
    const back = walls.find((component) => component.id === "back")!;
    const left = walls.find((component) => component.id === "left")!;
    const right = walls.find((component) => component.id === "right")!;
    expect(walls).toHaveLength(3); // Do not invent the unseen front wall.
    expect(back.position).toEqual([0, 0, -3]);
    expect(back.size[0]).toBe(6);
    expect(left.position).toEqual([-3, 0, 0]);
    expect(right.position).toEqual([3, 0, 0]);
    expect(left.size[2]).toBe(6);
    expect(right.size[2]).toBe(6);
    expect(back.position[0] - back.size[0] / 2).toBe(left.position[0]);
    expect(back.position[0] + back.size[0] / 2).toBe(right.position[0]);
    expect(left.position[2] - left.size[2] / 2).toBe(back.position[2]);
    expect(left.position[2] + left.size[2] / 2).toBeCloseTo(3);
  });

  it("marks a wall cropped at the image top as an estimated height, not a measured ceiling", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [
        { id: "floor", kind: "floor", side: "floor", bbox: [0, 0.6, 1, 1], confidence: 0.95 },
        { id: "back", kind: "wall", side: "image_back", bbox: [0.35, 0, 1, 0.6], confidence: 0.9 },
      ],
      items: [{ id: "tall_prop", name: "雕像", semanticType: "statue", bbox: [0.6, 0.01, 0.8, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source);
    const wall = draft.components.find((component) => component.id === "back")!;
    expect(wall.uncertain).toBe(true);
    expect(wall.notes).toContain("房间尺寸为暂估值，尚未根据图像标定");
    expect(draft.validationWarnings ?? []).not.toContain("component_exceeds_room_height");
  });

  it("uses an explicit support top even when the supported item appears first", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open",
      surfaces: [],
      items: [
        { id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.45, 0.4, 0.55, 0.6], confidence: 0.9, visibility: "visible", supportId: "table" },
        { id: "table", name: "桌", category: "table", semanticType: "table", bbox: [0.35, 0.4, 0.65, 0.62], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const lamp = draft.components.find((component) => component.id === "lamp")!;
    const table = draft.components.find((component) => component.id === "table")!;

    expect(lamp.supportComponentId).toBe("table");
    expect(lamp.position[1]).toBeCloseTo(table.position[1] + table.size[1]);
    expect(draft.components.some((component) => component.category === "wall")).toBe(false);
    expect(lamp).toMatchObject({ supportComponentId: "table", uncertain: true }); // height is anchored; bbox-derived XZ still needs review.
  });

  it("contains a supported footprint inside a rotated support footprint", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.8, 0.1, 1, 0.9], confidence: 0.95 }],
      items: [
        { id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.7, 0.4, 0.9, 0.6], confidence: 0.9, visibility: "visible", supportId: "table" },
        { id: "table", name: "桌", category: "table", semanticType: "table", bbox: [0.3, 0.3, 0.7, 0.7], confidence: 0.9, visibility: "visible", contactWallSide: "image_right" },
      ],
    }, source);
    const lamp = draft.components.find((component) => component.id === "lamp")!;
    const table = draft.components.find((component) => component.id === "table")!;
    const angle = table.rotationYDegrees * Math.PI / 180;
    const childAngle = lamp.rotationYDegrees * Math.PI / 180;
    const halfSupportX = table.size[0] / 2;
    const halfSupportZ = table.size[2] / 2;
    for (const xSign of [-1, 1]) for (const zSign of [-1, 1]) {
      const childX = xSign * lamp.size[0] / 2;
      const childZ = zSign * lamp.size[2] / 2;
      const worldX = lamp.position[0] + Math.cos(childAngle) * childX + Math.sin(childAngle) * childZ;
      const worldZ = lamp.position[2] - Math.sin(childAngle) * childX + Math.cos(childAngle) * childZ;
      const dx = worldX - table.position[0];
      const dz = worldZ - table.position[2];
      const localX = Math.cos(angle) * dx - Math.sin(angle) * dz;
      const localZ = Math.sin(angle) * dx + Math.cos(angle) * dz;
      expect(Math.abs(localX)).toBeLessThanOrEqual(halfSupportX + 1e-6);
      expect(Math.abs(localZ)).toBeLessThanOrEqual(halfSupportZ + 1e-6);
    }
    expect(lamp.uncertain).toBe(true);
  });

  it("centers an oversized child on its support, keeps its size, and marks uncertainty", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "bed", name: "床", semanticType: "bed", bbox: [0.8, 0.8, 1, 1], confidence: 0.9, visibility: "visible", supportId: "vase" },
        { id: "vase", name: "花瓶", semanticType: "prop", bbox: [0.45, 0.45, 0.55, 0.55], confidence: 0.9, visibility: "visible" },
      ],
    }, source);
    const bed = draft.components.find((component) => component.id === "bed")!;
    const vase = draft.components.find((component) => component.id === "vase")!;
    expect(bed.position[0]).toBeCloseTo(vase.position[0]);
    expect(bed.position[2]).toBeCloseTo(vase.position[2]);
    expect(bed.size).toEqual([2, 1.2, 2.2]);
    expect(bed.uncertain).toBe(true);
    expect(bed.notes).toContain("子物件 footprint 大于支撑面");
  });

  it("maps observed people into the existing character contract instead of object boxes", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [{ id: "bench", name: "矮桌", semanticType: "table", category: "table", bbox: [0.4, 0.4, 0.6, 0.65], confidence: 0.9, visibility: "visible" }],
      people: [{ id: "actor", name: "人物", bbox: [0.45, 0.35, 0.55, 0.65], confidence: 0.75, visibility: "visible", posture: "sit", supportId: "bench" }],
    }, source);
    expect(draft.components.map((component) => component.id)).toEqual(["bench"]);
    expect(draft.characters).toHaveLength(1);
    expect(draft.characters[0]).toMatchObject({
      id: "actor", position: [expect.any(Number), expect.any(Number), expect.any(Number)], height: 1.7,
      posture: "sit", supportComponentId: "bench", uncertain: true,
    });
    expect(draft.characters[0].position[1]).toBeCloseTo(0.75);
  });

  it("preserves explicit kneel variants and prayer gesture while retaining unknown posture", () => {
    const draft = imageObservationToLayoutDraft({
      surfaces: [],
      items: [{ id: "mat", name: "垫子", semanticType: "mat", bbox: [0.2, 0.65, 0.8, 0.75], confidence: 0.9, visibility: "visible" }],
      people: [
        { id: "praying", name: "跪拜女子", bbox: [0.3, 0.25, 0.45, 0.65], confidence: 0.95, visibility: "visible", posture: "kneel", facingDirection: "image_up", kneelVariant: "seiza", handGesture: "prayer", supportId: "mat" },
        { id: "unclear", name: "人物乙", bbox: [0.6, 0.2, 0.75, 0.7], confidence: 0.5, visibility: "uncertain", posture: "unknown", facingDirection: "unknown" },
      ],
    }, source);
    const praying = draft.characters.find((character) => character.id === "praying")!;
    const unclear = draft.characters.find((character) => character.id === "unclear")!;
    expect(praying).toMatchObject({ posture: "kneel", facingDirection: "image_up", rotationYDegrees: 180, kneelVariant: "seiza", handGesture: "prayer", supportComponentId: "mat" });
    const prayingAdapter = createLayoutCharacterRenderAdapter(praying);
    expect(prayingAdapter.characterRig.posePresetId).toBe("seiza");
    expect(prayingAdapter.characterRig.controls["leftElbow.bend"]).toBe(96);
    expect(prayingAdapter.transform.rotation[1]).toBeCloseTo(Math.PI);
    expect(unclear.posture).toBe("unknown");
    expect(unclear.facingDirection).toBe("unknown");
    expect(createLayoutCharacterRenderAdapter(unclear).characterRig.posePresetId).toBe("stand");
  });

  it.each(["missing", "cycle"] as const)("keeps %s support references at floor height and uncertain", (mode) => {
    const items = mode === "missing"
      ? [{ id: "lamp", name: "台灯", semanticType: "table_lamp", bbox: [0.45, 0.4, 0.55, 0.6], confidence: 0.9, visibility: "visible", supportId: "absent" }]
      : [
        { id: "a", name: "物件甲", category: "prop", bbox: [0.2, 0.4, 0.4, 0.6], confidence: 0.9, visibility: "visible", supportId: "b" },
        { id: "b", name: "物件乙", category: "prop", bbox: [0.6, 0.4, 0.8, 0.6], confidence: 0.9, visibility: "visible", supportId: "a" },
      ];
    const draft = imageObservationToLayoutDraft({ spaceType: "open", surfaces: [], items }, source);
    expect(draft.components.every((component) => component.position[1] === 0 && component.uncertain)).toBe(true);
    expect(draft.components.some((component) => component.category === "wall")).toBe(false);
  });

  it("places ordinary furniture against a wall without mounting it", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "right_wall", kind: "wall", side: "image_right", bbox: [0.8, 0.1, 1, 0.9], confidence: 0.95 }],
      items: [{ id: "desk", name: "书桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9, visibility: "visible", againstSurfaceId: "right_wall" }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect(desk.rotationYDegrees).toBe(-90);
    expect(desk.position[0] + desk.size[2] / 2).toBeCloseTo(2.9); // 2.925m wall inner face minus 0.025m gap.
    expect(desk.position[1]).toBe(0);
    expect(desk.uncertain).toBe(true);
    expect(draft.relations).toContainEqual({ fromId: "desk", toId: "right_wall", type: "adjacent_to", confidence: 0.9 });
  });

  it.each([
    ["image_right", -90],
    ["image_back", 0],
  ] as const)("keeps a floor-placed desk's explicit %s wall contact", (side, expectedYaw) => {
    const surface = side === "image_right"
      ? { id: "contact_wall", kind: "wall" as const, side, bbox: [0.8, 0.1, 1, 0.9] as [number, number, number, number], confidence: 0.95 }
      : { id: "contact_wall", kind: "wall" as const, side, bbox: [0.1, 0.1, 0.9, 0.9] as [number, number, number, number], confidence: 0.95 };
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [surface],
      items: [{ id: "desk", name: "书桌", semanticType: "desk", bbox: [0.7, 0.4, 0.9, 0.7], confidence: 0.9, visibility: "visible", placement: "floor", contactWallSide: side }],
    }, source);
    const desk = draft.components.find((component) => component.id === "desk")!;
    expect(desk.rotationYDegrees).toBe(expectedYaw);
    expect(desk.position[1]).toBe(0);
    expect(desk.uncertain).toBe(true);
    expect(draft.relations).toContainEqual({ fromId: "desk", toId: "contact_wall", type: "adjacent_to", confidence: 0.9 });
  });

  it("keeps unsupported open-space items uncertain instead of adding walls", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [{ id: "prop", name: "物件", category: "prop", bbox: [0.4, 0.4, 0.6, 0.6], confidence: 0.9, visibility: "visible" }],
    }, source);
    expect(draft.components).toHaveLength(1);
    expect(draft.components[0].category).toBe("prop");
    expect(draft.components[0].uncertain).toBe(true);
    expect(draft.spaceType).toBe("open");
  });

  it("honors partOf as a geometry-included contract for arbitrary semantic types", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "table", name: "桌子", semanticType: "table", category: "table", bbox: [0.2, 0.3, 0.8, 0.8], confidence: 0.9, visibility: "visible" },
        { id: "vase", name: "花瓶", semanticType: "prop", category: "prop", bbox: [0.4, 0.3, 0.6, 0.5], confidence: 0.9, visibility: "visible", partOfId: "table" },
        { id: "flower", name: "花枝", semanticType: "plant", category: "prop", bbox: [0.42, 0.18, 0.56, 0.32], confidence: 0.9, visibility: "visible", placement: "supported", supportId: "vase" },
      ],
    }, source);
    expect(draft.components.map((component) => component.id)).toEqual(["table", "flower"]);
    expect(draft.components.find((component) => component.id === "flower")).toMatchObject({ supportComponentId: "table", uncertain: true });
    expect(draft.components.find((component) => component.id === "flower")?.notes).toContain("原支撑对象已归入父组件");
    expect(draft.observations?.some((observation) => observation.componentId === "table" && observation.evidence?.includes("不重复生成几何"))).toBe(true);
  });

  it("folds explicit bed-linen children into a bed without changing independently supported bedding", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "bed", name: "床", semanticType: "bed", bbox: [0.2, 0.3, 0.8, 0.8], confidence: 0.9, visibility: "visible" },
        { id: "bedding", name: "white bedding", semanticType: "bedding", bbox: [0.2, 0.35, 0.8, 0.78], confidence: 0.9, visibility: "visible", partOfId: "bed", supportId: "bed" },
        { id: "throw", name: "throw blanket", semanticType: "blanket", bbox: [0.3, 0.5, 0.55, 0.7], confidence: 0.9, visibility: "visible", supportId: "bed" },
      ],
    }, source);
    expect(draft.components.map((component) => component.id)).not.toContain("bedding");
    expect(draft.components.map((component) => component.id)).toContain("throw");
    expect(draft.components.find((component) => component.id === "throw")?.supportComponentId).toBe("bed");
  });

  it("keeps cyclic partOf items instead of dropping both components", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "open", surfaces: [],
      items: [
        { id: "a", name: "物件甲", semanticType: "bed", bbox: [0.1, 0.3, 0.5, 0.8], confidence: 0.8, visibility: "visible", partOfId: "b" },
        { id: "b", name: "床头板", category: "cabinet", bbox: [0.4, 0.3, 0.6, 0.6], confidence: 0.8, visibility: "visible", partOfId: "a" },
      ],
    }, source);
    expect(draft.components.map((component) => component.id)).toEqual(["a", "b"]);
    expect(draft.components.every((component) => component.uncertain)).toBe(true);
  });

  it("keeps an invalid wall reference uncertain at bbox fallback without inventing a wall", () => {
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed", surfaces: [],
      items: [{ id: "cabinet", name: "柜子", semanticType: "cabinet", category: "cabinet", bbox: [0.2, 0.4, 0.4, 0.8], confidence: 0.9, visibility: "visible", againstSurfaceId: "x".repeat(5000) }],
    }, source);
    expect(draft.components).toHaveLength(1);
    const cabinet = draft.components[0];
    expect(cabinet).toMatchObject({ id: "cabinet", uncertain: true });
    expect(cabinet.position[0]).toBeCloseTo(-1.2);
    expect(cabinet.position[1]).toBe(0);
    expect(cabinet.position[2]).toBeCloseTo(1.6);
    expect(draft.relations).toBeUndefined();
    expect(draft.components.some((component) => component.category === "wall")).toBe(false);
  });

  it("prioritizes bounded observation and relation evidence and exposes truncation", () => {
    const items = Array.from({ length: 29 }, (_, index) => ({
      id: `item_${index}`,
      name: `物件${index}`,
      category: "prop",
      bbox: [0.1 + index * 0.001, 0.4, 0.3 + index * 0.001, 0.7],
      confidence: 0.8,
      visibility: "visible",
      againstSurfaceId: "back_wall",
    }));
    const draft = imageObservationToLayoutDraft({
      spaceType: "enclosed",
      surfaces: [{ id: "back_wall", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.9], confidence: 0.9 }],
      items,
    }, source);
    expect(draft.observations).toHaveLength(12);
    expect(draft.relations).toHaveLength(24);
    expect(draft.validationWarnings).toContain("observations_truncated");
    expect(draft.validationWarnings).toContain("relations_truncated");
  });

  it("leaves the existing legacy candidate path unchanged", () => {
    const legacy = validateLayoutDraftCandidate({
      components: [{
        id: "legacy_wall", name: "墙", category: "wall", primitive: "box", position: [0, 0, -3], size: [6, 2.8, 0.15],
        rotationYDegrees: 0, confidence: 0.8, uncertain: false,
      }],
    }, source);
    expect(legacy.components[0]).not.toHaveProperty("semanticType");
    expect(legacy.components[0]).not.toHaveProperty("assembly");
    expect(legacy.spaceType).toBeUndefined();
  });

  it("rejects an out-of-range normalized bbox", () => {
    expect(() => imageObservationToLayoutDraft({
      surfaces: [],
      items: [{ id: "bad", name: "物件", category: "prop", bbox: [-0.1, 0.2, 0.3, 0.4], confidence: 0.8, visibility: "visible" }],
    }, source)).toThrow(ImageObservationValidationError);
  });

  it("accepts disjoint collinear contour edges but rejects true self-intersections in both observation conversion and layout candidates", () => {
    const base = { id: "sofa", name: "组合沙发", semanticType: "sofa", category: "sofa", bbox: [0.1, 0.2, 0.9, 0.9], confidence: 0.9, visibility: "visible" };
    const collinearBoundary = [[0.1, 0.1], [0.3, 0.1], [0.5, 0.1], [0.7, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] as [number, number][];
    expect(() => imageObservationToLayoutDraft({ surfaces: [], items: [{ ...base, groundFootprints: [{ outer: collinearBoundary, visibility: "visible", confidence: 0.9 }] }] }, source)).not.toThrow();
    const crossing = [[0.1, 0.1], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1]] as [number, number][];
    expect(() => imageObservationToLayoutDraft({ surfaces: [], items: [{ ...base, groundFootprints: [{ outer: crossing, visibility: "visible", confidence: 0.9 }] }] }, source)).toThrow(ImageObservationValidationError);
  });

  it("rejects footprint holes whose edges cross concave borders or each other", () => {
    const base = { id: "sofa", name: "组合沙发", semanticType: "sofa", category: "sofa", bbox: [0.05, 0.05, 0.95, 0.95], confidence: 0.9, visibility: "visible" };
    const outer = [[0.05, 0.05], [0.85, 0.05], [0.85, 0.35], [0.35, 0.35], [0.35, 0.85], [0.05, 0.85]];
    const crossingConcavity = [[0.1, 0.1], [0.75, 0.1], [0.1, 0.75]];
    expect(() => imageObservationToLayoutDraft({ surfaces: [], items: [{ ...base, groundFootprints: [{ outer, holes: [crossingConcavity], visibility: "visible", confidence: 0.9 }] }] }, source)).toThrow(ImageObservationValidationError);

    const square = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];
    const overlapping = [[0.65, 0.35], [0.35, 0.35], [0.35, 0.65], [0.65, 0.65]];
    expect(() => imageObservationToLayoutDraft({ surfaces: [], items: [{ ...base, groundFootprints: [{ outer: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]], holes: [square, overlapping], visibility: "visible", confidence: 0.9 }] }] }, source)).toThrow(ImageObservationValidationError);
  });
});
