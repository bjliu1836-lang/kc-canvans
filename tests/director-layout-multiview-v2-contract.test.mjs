import test from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTOR_LAYOUT_OBSERVATION_FORMAT_V2,
  DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT,
  buildDirectorLayoutImageContent,
  normalizeDirectorLayoutReferenceImages,
  parseDirectorLayoutObservationV2,
} from "../functions/shared/director-layout-observations.js";

const view = (sourceId, itemIds = ["chair"]) => ({
  sourceId,
  entities: [
    { entityId: "floor", side: "floor", bbox: [0, 0, 1, 1], confidence: 0.9, visibility: "visible", mainColor: null },
    ...itemIds.map((entityId) => ({ entityId, bbox: [0.2, 0.2, 0.6, 0.8], confidence: 0.9, visibility: "visible", mainColor: null })),
  ],
});

const entity = (id, extra = {}) => ({ id, kind: "item", name: id, semanticType: "chair", category: "chair", placement: "floor", identityConfidence: 0.9, uncertain: false, ...extra });
const base = (sourceIds = ["view-a"]) => ({
  contractVersion: DIRECTOR_LAYOUT_OBSERVATION_FORMAT_V2,
  spaceType: "enclosed",
  entities: [{ id: "floor", kind: "surface", name: "floor", surfaceKind: "floor", identityConfidence: 0.9, uncertain: false }, entity("chair")],
  views: sourceIds.map((sourceId) => view(sourceId)),
  relations: [],
});

test("v2 accepts one-to-three unordered source views with one global identity registry", () => {
  for (const sourceIds of [["view-a"], ["view-a", "view-b"], ["view-c", "view-a", "view-b"]]) {
    assert.doesNotThrow(() => parseDirectorLayoutObservationV2(JSON.stringify(base(sourceIds)), sourceIds));
  }
});

test("v2 validates each view strictly, including nested geometry and landmarks", () => {
  const invalid = base(["view-a", "view-b"]);
  invalid.views[1].entities[1].bbox = [0, 0, 1];
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(invalid), ["view-a", "view-b"]));

  const badNested = base();
  badNested.views[0].geometryEvidence = { axes: [{ axis: "depth", segments: [{ start: [0, 0], end: [1, 1], confidence: 0.8, unexpected: true }] }] };
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(badNested), ["view-a"]));

  const tooManyLandmarks = base();
  tooManyLandmarks.views[0].groundLandmarks = Array.from({ length: 9 }, (_, index) => ({ pointId: `p${index}`, planeId: "floor", point: [index / 10, 0.8], confidence: 0.9, visibility: "visible" }));
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(tooManyLandmarks), ["view-a"]));
});

test("v2 rejects conflicting single-value relations and support/part cycles", () => {
  const conflict = base();
  conflict.entities.push(entity("chair-2"));
  conflict.views[0].entities.push({ entityId: "chair-2", bbox: [0.6, 0.2, 0.9, 0.8], confidence: 0.8, visibility: "visible", mainColor: null });
  conflict.relations = [
    { type: "support", from: "chair", to: "floor", confidence: 0.9 },
    { type: "support", from: "chair", to: "chair-2", confidence: 0.9 },
  ];
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(conflict), ["view-a"]));

  const cycle = base();
  cycle.entities.push(entity("chair-2"));
  cycle.views[0].entities.push({ entityId: "chair-2", bbox: [0.6, 0.2, 0.9, 0.8], confidence: 0.8, visibility: "visible", mainColor: null });
  cycle.relations = [
    { type: "support", from: "chair", to: "chair-2", confidence: 0.9 },
    { type: "partOf", from: "chair-2", to: "chair", confidence: 0.9 },
  ];
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(cycle), ["view-a"]));
});

test("v2 permits multiple wall contacts but rejects mixed floor point IDs and wrong-kind fields", () => {
  const multiAgainst = base();
  multiAgainst.entities.push(
    { id: "wall-a", kind: "surface", name: "wall-a", surfaceKind: "wall", identityConfidence: 0.9, uncertain: false },
    { id: "wall-b", kind: "surface", name: "wall-b", surfaceKind: "wall", identityConfidence: 0.9, uncertain: false },
  );
  multiAgainst.views[0].entities.push(
    { entityId: "wall-a", side: "image_left", bbox: [0, 0, 0.1, 1], confidence: 0.9, visibility: "visible", mainColor: null },
    { entityId: "wall-b", side: "image_right", bbox: [0.9, 0, 1, 1], confidence: 0.9, visibility: "visible", mainColor: null },
  );
  multiAgainst.relations = [
    { type: "against", from: "chair", to: "wall-a", confidence: 0.8 },
    { type: "against", from: "chair", to: "wall-b", confidence: 0.8 },
  ];
  assert.doesNotThrow(() => parseDirectorLayoutObservationV2(JSON.stringify(multiAgainst), ["view-a"]));

  const mismatchedPoint = base(["view-a", "view-b"]);
  mismatchedPoint.entities.push({ id: "other-floor", kind: "surface", name: "other floor", surfaceKind: "floor", identityConfidence: 0.9, uncertain: false });
  for (const item of mismatchedPoint.views) item.entities.find((entry) => entry.entityId === "chair").groundContacts = [
    { point: [0.4, 0.8], kind: "corner", visibility: "visible", confidence: 0.9, pointId: "same-contact", planeId: "floor" },
  ];
  mismatchedPoint.views[1].entities.find((entry) => entry.entityId === "chair").groundContacts[0].planeId = "other-floor";
  mismatchedPoint.views[1].entities.push({ entityId: "other-floor", side: "floor", bbox: [0, 0, 1, 1], confidence: 0.9, visibility: "visible", mainColor: null });
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(mismatchedPoint), ["view-a", "view-b"]));

  const wrongKind = base();
  wrongKind.entities[1].surfaceKind = "floor";
  assert.throws(() => parseDirectorLayoutObservationV2(JSON.stringify(wrongKind), ["view-a"]));
});

test("v2 accepts directly visible person posture evidence despite an occluded second view", () => {
  const fixture = base(["view-a", "view-b"]);
  fixture.entities.push({ id: "person-1", kind: "person", name: "person", posture: "kneel", kneelVariant: "seiza", handGesture: "prayer", identityConfidence: 0.9, uncertain: false });
  fixture.views[0].entities.push({ entityId: "person-1", bbox: [0.3, 0.2, 0.5, 0.9], confidence: 0.9, visibility: "visible", facingDirection: "toward_camera" });
  fixture.views[1].entities.push({ entityId: "person-1", bbox: [0.3, 0.2, 0.5, 0.9], confidence: 0.5, visibility: "occluded", facingDirection: "unknown" });
  assert.doesNotThrow(() => parseDirectorLayoutObservationV2(JSON.stringify(fixture), ["view-a", "view-b"]));
});

test("v2 source IDs allow the request limit and images have neutral V2 labels", () => {
  const longSourceId = "s".repeat(100);
  assert.doesNotThrow(() => parseDirectorLayoutObservationV2(JSON.stringify(base([longSourceId])), [longSourceId]));
  const images = normalizeDirectorLayoutReferenceImages({
    outputFormat: DIRECTOR_LAYOUT_OBSERVATION_FORMAT_V2,
    images: [{ id: "a", sourceId: "a", url: "https://example.test/a.png" }, { id: "b", sourceId: "b", url: "https://example.test/b.png" }],
  });
  const v2Labels = buildDirectorLayoutImageContent(images, DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT, { multiView: true })
    .filter((part) => part.type === "text").map((part) => part.text).join(" ");
  assert.doesNotMatch(v2Labels, /主图|辅图|primary|supplementary/i);
  const v1Labels = buildDirectorLayoutImageContent([{ id: "a", role: "primary", sourceId: "a", url: "https://example.test/a.png" }], "v1");
  assert.match(v1Labels[0].text, /主图/);
});

test("the V2 prompt includes a complete parseable example consistent with the shared parser", () => {
  const match = DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT.match(/最小单图例子：(\{.*\})。关系形状/);
  assert.ok(match, "prompt should contain an explicit complete sample");
  assert.doesNotThrow(() => parseDirectorLayoutObservationV2(match[1], ["source-1"]));
  assert.match(DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT, /ground\|wall\|door\|window\|table\|chair\|sofa\|cabinet\|pillar\|prop/);
  assert.match(DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT, /support为item\/person→item或floor surface；partOf为item→item；against为item→wall surface/);
  assert.match(DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT, /sourceId最多128字符/);
});

\n