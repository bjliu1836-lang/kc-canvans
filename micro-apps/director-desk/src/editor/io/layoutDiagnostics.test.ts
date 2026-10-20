import { beforeEach, expect, it } from "vitest";
import { buildLayoutBatch, validateLayoutDraftCandidate } from "../schema/layoutDraft";
import { readLayoutDiagnosticRecords, recordLayoutDraftApplied, recordLayoutGenerationStarted, recordLayoutReferencePreview, recordNormalizedLayoutDraft, shouldEnableLayoutDiagnostics } from "./layoutDiagnostics";

const source = { sourceId: "image_private_id", fileName: "person-name-room.png" };
const validCandidate = (draftId: string) => validateLayoutDraftCandidate({
  components: [{
    id: "wall", category: "wall", primitive: "box", position: [0, 0, 0], size: [2, 2.5, 0.1],
    rotationYDegrees: 0, confidence: 0.8, visible: true,
  }],
}, source, { draftId });

beforeEach(() => window.sessionStorage.clear());

it("only enables production diagnostics for the explicit Director Desk URL flag", () => {
  expect(shouldEnableLayoutDiagnostics(false, "")).toBe(false);
  expect(shouldEnableLayoutDiagnostics(false, "?directorLayoutDiagnostics=1")).toBe(true);
  expect(shouldEnableLayoutDiagnostics(false, "?directorLayoutDiagnostics=0")).toBe(false);
  expect(shouldEnableLayoutDiagnostics(false, "?unrelated=1")).toBe(false);
});

it("correlates candidate, normalized, preview and applied geometry without provider prose or source labels", () => {
  const draft = validateLayoutDraftCandidate({
    spaceType: "open",
    observations: [{ componentId: "wall_01", state: "visible", confidence: 0.9, evidence: "private raw evidence" }],
    relations: [],
    components: [{
      id: "wall_01", name: "private model label", category: "wall", primitive: "box",
      position: [0, 0, 0], size: [6, 2.8, 0.15], rotationYDegrees: 0,
      confidence: 0.9, notes: "provider original text", visible: true,
    }],
  }, source, { draftId: "trace_1", imageAspectRatio: 9 / 16 });
  const built = buildLayoutBatch(draft, "batch_1", []);
  recordLayoutGenerationStarted("generation_a");
  recordNormalizedLayoutDraft(draft, "generation_a", {
    spaceType: "open",
    observations: [{ componentId: "wall_01", state: "visible", confidence: 0.9, evidence: "private raw evidence" }],
    components: [{ ...draft.components[0], name: "private model label", notes: "provider original text", arbitraryExtra: "private" }],
    apiKey: "secret",
  });
  recordLayoutReferencePreview("generation_a", true, draft.referenceCamera);
  recordLayoutDraftApplied("generation_a", built.batch.id, built.objects);

  const records = readLayoutDiagnosticRecords();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    generationId: "generation_a",
    draftId: "trace_1",
    candidate: { spaceType: "open", components: [{ id: "wall_01", category: "wall" }] },
    normalized: { spaceType: "open", referenceCamera: { imageAspectRatio: 9 / 16 } },
    stages: [{ phase: "request-started" }, { phase: "normalized" }, { phase: "reference-preview-start" }, { phase: "applied", batchId: "batch_1" }],
  });
  const serialized = JSON.stringify(records[0]);
  for (const privateValue of ["private raw evidence", "provider original text", "private model label", source.fileName, source.sourceId, "secret", "arbitraryExtra"]) {
    expect(serialized).not.toContain(privateValue);
  }
  expect(records[0]?.candidate?.components).toMatchObject([{ id: "wall_01", category: "wall" }]);
});

it("retains placement and facing relations when sanitizing image-observation diagnostics", () => {
  const draft = validCandidate("trace_observation_relations");
  recordLayoutGenerationStarted("generation_observation_relations");
  recordNormalizedLayoutDraft(draft, "generation_observation_relations", {
    observationFormat: "image-observations-v1",
    visualObservations: {
      spaceType: "open", surfaces: [],
      items: [{
        id: "chair", name: "椅子", semanticType: "chair", category: "chair", bbox: [0.1, 0.3, 0.3, 0.8],
        confidence: 0.9, visibility: "visible", supportId: "desk", partOfId: "set",
        placement: "supported", facingTowardId: "target",
      }],
      people: [],
    },
  });
  const item = (readLayoutDiagnosticRecords()[0]?.candidate?.visualObservations as any)?.items?.[0];
  expect(item).toMatchObject({ supportId: "desk", partOfId: "set", placement: "supported", facingTowardId: "target" });
});

it("preserves bounded rear-feature and assembly geometry tuples in candidate diagnostics", () => {
  const draft = validateLayoutDraftCandidate({
    components: [{
      id: "sofa", category: "sofa", semanticType: "沙发\u0001", primitive: "box",
      position: [0, 0, 0], size: [2, 0.8, 0.9], rotationYDegrees: 0, confidence: 0.9, visible: true,
    }],
  }, source, { draftId: "trace_geometry_tuples" });
  recordLayoutGenerationStarted("generation_geometry_tuples");
  recordNormalizedLayoutDraft(draft, "generation_geometry_tuples", {
    observationFormat: "image-observations-v1",
    visualObservations: {
      spaceType: "open", surfaces: [],
      items: [{
        id: "sofa", name: "沙发", semanticType: "沙发\u0001", category: "sofa", bbox: [0.1, 0.2, 0.7, 0.8], confidence: 0.9, visibility: "visible",
        rearFeature: { name: "靠背", bbox: [0.15, 0.3, 0.65, 0.45] },
      }],
      people: [],
    },
    components: [{
      id: "bed", category: "sofa", semanticType: "沙发\u0001", primitive: "box", position: [1, 0, 2], size: [2, 1, 3],
      assembly: [{ id: "backrest", primitive: "box", position: [0, 0.4, -0.8], size: [1.8, 0.8, 0.2] }],
    }],
  });

  const candidate = readLayoutDiagnosticRecords()[0]?.candidate as any;
  const normalized = readLayoutDiagnosticRecords()[0]?.normalized;
  expect(candidate.visualObservations.items[0].rearFeature.bbox).toEqual([0.15, 0.3, 0.65, 0.45]);
  expect(candidate.visualObservations.items[0].semanticType).toBe("沙发\u0001");
  expect(candidate.components[0].assembly[0]).toMatchObject({
    position: [0, 0.4, -0.8],
    size: [1.8, 0.8, 0.2],
  });
  expect(normalized?.components[0]?.semanticType).toBe("沙发");
});

it("keeps independent generation ids when the provider reuses a draft id", () => {
  const draft = validCandidate("same-provider-id");
  const built = buildLayoutBatch(draft, "batch_same", []);
  recordLayoutGenerationStarted("generation_a");
  recordNormalizedLayoutDraft(draft, "generation_a", { components: [] });
  recordLayoutGenerationStarted("generation_b");
  recordNormalizedLayoutDraft(draft, "generation_b", { components: [] });
  recordLayoutReferencePreview("generation_a", true, draft.referenceCamera);
  recordLayoutDraftApplied("generation_b", built.batch.id, built.objects);
  expect(readLayoutDiagnosticRecords()).toMatchObject([
    { generationId: "generation_a", draftId: "same-provider-id", stages: [{ phase: "request-started" }, { phase: "normalized" }, { phase: "reference-preview-start" }] },
    { generationId: "generation_b", draftId: "same-provider-id", stages: [{ phase: "request-started" }, { phase: "normalized" }, { phase: "applied", batchId: "batch_same" }] },
  ]);
});

it("drops oversized candidates and keeps the stored diagnostic bounded", () => {
  const draft = validCandidate("trace_large");
  recordLayoutGenerationStarted("generation_large");
  recordNormalizedLayoutDraft(draft, "generation_large", { components: [], spaceType: "x".repeat(100_000) });
  const record = readLayoutDiagnosticRecords()[0];
  expect((record?.candidate?.spaceType as string).length).toBeLessThanOrEqual(120);
  expect(window.sessionStorage.getItem("kc.director-layout-diagnostics.v1")?.length ?? 0).toBeLessThan(256 * 1024);
});
