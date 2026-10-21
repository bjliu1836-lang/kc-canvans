import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLayoutDiagnosticRecords } from "./layoutDiagnostics";
import { requestReferenceLayout, shouldRequestSpatialReview } from "./referenceLayoutClient";

const image = {
  sourceId: "local_test",
  fileName: "reference.png",
  url: "data:image/png;base64,AA==",
  origin: "local" as const,
};

function rejectWithIssues(issues?: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "DIRECTOR_LAYOUT_INVALID_MODEL_JSON",
          issues,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      )
    )
  );
  return requestReferenceLayout(image);
}

describe("requestReferenceLayout failure details", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
      location: { search: "" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("overrides a provider-supplied trace field with a client generation id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      observationFormat: "image-observations-v1",
      visualObservations: {
        spaceType: "enclosed",
        surfaces: [{ id: "wall", kind: "wall", side: "image_back", bbox: [0, 0.1, 1, 0.8], confidence: 0.8 }],
        items: [{ id: "chair", name: "椅子", semanticType: "chair", category: "chair", bbox: [0.1, 0.3, 0.3, 0.8], confidence: 0.9, visibility: "visible", supportId: "desk", partOfId: "set", placement: "supported", facingTowardId: "target" }],
        diagnosticGenerationId: "provider-forged-id",
        cameraPosition: [0, 0, 0],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const draft = await requestReferenceLayout(image);
    const records = readLayoutDiagnosticRecords();
    const record = records[records.length - 1];

    expect(draft.diagnosticGenerationId).toMatch(/^layout-/);
    expect(draft.diagnosticGenerationId).not.toBe("provider-forged-id");
    expect(record?.generationId).toBe(draft.diagnosticGenerationId);
    expect(record?.draftId).toBe(draft.id);
    expect(record?.draftId).not.toBe(draft.diagnosticGenerationId);
    expect(JSON.stringify(record)).not.toContain("provider-forged-id");
    expect((record?.candidate as Record<string, unknown>)?.observationFormat).toBe("image-observations-v1");
    expect(JSON.stringify(record?.candidate)).toContain('"id":"wall"');
    const candidateObservations = (record?.candidate as Record<string, unknown>)?.visualObservations as { items?: unknown[] } | undefined;
    expect(candidateObservations?.items).toMatchObject([{
      id: "chair", supportId: "desk", partOfId: "set", placement: "supported", facingTowardId: "target",
    }]);
    expect(record?.normalized.components.some((component) => component.id === "wall")).toBe(true);
    expect(JSON.stringify(record?.candidate)).not.toContain("cameraPosition");
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody.outputFormat).toBe("image-observations-v1");
    expect(requestBody.images).toMatchObject([{ id: "local_test", role: "primary", sourceId: "local_test" }]);
    expect(requestBody.image).toBeUndefined();
    expect(draft.components.find((component) => component.id === "chair")?.sourceImageEvidence?.sourceId).toBe("local_test");
  });

  it("requests at most one spatial review when major-item evidence coverage is low and merges spatial fields only", async () => {
    const observation = {
      spaceType: "enclosed",
      surfaces: [{ id: "floor", kind: "floor", side: "floor", bbox: [0, 0.65, 1, 1], confidence: 0.9, visibility: "visible" }],
      items: [
        { id: "sofa", name: "转角组合沙发", category: "sofa", semanticType: "sofa_main", bbox: [0.1, 0.2, 0.65, 0.8], confidence: 0.9, visibility: "visible", groundFootprints: [{ outer: [[0.1, 0.7], [0.65, 0.7], [0.65, 0.9]], visibility: "visible", confidence: 0.4 }] },
        { id: "table", name: "茶几", category: "table", semanticType: "coffee_table", bbox: [0.35, 0.55, 0.65, 0.8], confidence: 0.9, visibility: "visible" },
      ],
    };
    const footprint = { outer: [[0.1, 0.7], [0.65, 0.7], [0.65, 0.9], [0.1, 0.9]], visibility: "visible", confidence: 0.8 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ observationFormat: "image-observations-v1", visualObservations: observation }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        observationFormat: "image-observations-v1",
        spatialReviewPatch: { items: [{ id: "sofa", groundFootprints: [footprint] }] },
        providerModel: "deepseek-flash-v4.1-1017",
        promptHash: "a".repeat(64),
        providerFinishReason: "stop",
        usage: { total_tokens: 1200 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sideImage = { ...image, sourceId: "canvas_side", fileName: "side.png", origin: "canvas" as const, url: "https://example.test/side.png" };
    const detailImage = { ...image, sourceId: "local_detail", fileName: "detail.png", url: "data:image/png;base64,AQ==" };
    const draft = await requestReferenceLayout([image, sideImage, detailImage]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reviewBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(reviewBody.observationStage).toBe("spatial-review");
    const expectedGroup = [
      { id: "local_test", role: "primary", sourceId: "local_test" },
      { id: "canvas_side", role: "supplementary", sourceId: "canvas_side" },
      { id: "local_detail", role: "supplementary", sourceId: "local_detail" },
    ];
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).images).toMatchObject(expectedGroup);
    expect(reviewBody.images).toMatchObject(expectedGroup);
    expect(reviewBody.image).toBeUndefined();
    expect((reviewBody.reviewContext as { missingEvidence?: string[] }).missingEvidence).toContain("non-convex-contact-boundary");
    expect((reviewBody.baseObservations as typeof observation).items[0]?.id).toBe("sofa");
    const records = readLayoutDiagnosticRecords();
    const record = records[records.length - 1];
    const candidate = record?.candidate as { visualObservations?: typeof observation; spatialReview?: Record<string, unknown> } | undefined;
    expect(candidate?.spatialReview).toMatchObject({ attempted: true, accepted: true, providerModel: "deepseek-flash-v4.1-1017", promptHash: "a".repeat(64) });
    expect(candidate?.visualObservations?.items[0]).toMatchObject({ id: "sofa", name: "转角组合沙发", category: "sofa", groundFootprints: [footprint] });
    expect(draft.diagnosticGenerationId).toBe(record?.generationId);
  });

  it("rejects a reference group outside the three-image and aggregate payload limits without sending it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestReferenceLayout([image, image, image, image])).rejects.toThrow("1 到 3 张");
    const tooLarge = (sourceId: string) => ({ ...image, sourceId, url: `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}` });
    await expect(requestReferenceLayout([tooLarge("a"), tooLarge("b"), tooLarge("c")])).rejects.toThrow("合计过大");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the coarse draft when the single spatial review fails", async () => {
    const observation = {
      surfaces: [{ id: "floor", kind: "floor", side: "floor", bbox: [0, 0.65, 1, 1], confidence: 0.9, visibility: "visible" }],
      items: [{ id: "sofa", name: "沙发", category: "sofa", semanticType: "sofa_main", bbox: [0.1, 0.2, 0.65, 0.8], confidence: 0.9, visibility: "visible" }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ observationFormat: "image-observations-v1", visualObservations: observation }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "DIRECTOR_LAYOUT_UPSTREAM_FAILURE" }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const draft = await requestReferenceLayout(image);
    expect(draft.components.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const records = readLayoutDiagnosticRecords();
    const record = records[records.length - 1];
    expect((record?.candidate as { spatialReview?: unknown } | undefined)?.spatialReview).toMatchObject({ attempted: true, accepted: false });
  });

  it("rejects an invalid observation response instead of falling back to a legacy draft", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      observationFormat: "image-observations-v1",
      visualObservations: {
        surfaces: [],
        items: [{ id: "bad", name: "物件", category: "prop", bbox: [-1, 0, 0.2, 0.3], confidence: 0.8, visibility: "visible" }],
        components: [{ id: "legacy-wall" }],
      },
      draft: { components: [{ id: "legacy-wall", category: "wall" }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(requestReferenceLayout(image)).rejects.toThrow("item 1的 id、bbox 或 confidence 无效");
  });

  it("records only bounded parser evidence and classifies model schema failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID",
      issues: ["图像观察对象无效"],
      issuePaths: ["$.items[0].contactWallSide:invalid"],
      outputShape: { outputBytes: 500, rootKeys: ["surfaces", "items"], rootTypes: { items: "array" } },
      raw: "must-not-be-recorded",
    }), { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(requestReferenceLayout(image)).rejects.toThrow("图像观察对象无效");
    const records = readLayoutDiagnosticRecords();
    const stages = records[records.length - 1]?.stages ?? [];
    const failed = stages[stages.length - 1];
    expect(failed).toMatchObject({ code: "model-schema", evidence: { issuePaths: ["$.items[0].contactWallSide:invalid"] } });
    expect(JSON.stringify(failed)).not.toContain("must-not-be-recorded");
  });

  it("classifies converter failures as geometry failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      observationFormat: "image-observations-v1",
      visualObservations: { spaceType: "open", surfaces: [], items: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(requestReferenceLayout(image)).rejects.toThrow("没有可安全转换的可见墙面或物品");
    const records = readLayoutDiagnosticRecords();
    const stages = records[records.length - 1]?.stages ?? [];
    expect(stages[stages.length - 1]).toMatchObject({ code: "geometry-error" });
  });

  it("continues to accept an old server response that has a draft and no observation format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ draft: {
      components: [{ id: "legacy-wall", name: "墙", category: "wall", primitive: "box", position: [0, 0, -3], size: [6, 2.8, 0.15], rotationYDegrees: 0, confidence: 0.8, uncertain: false }],
      characters: [],
    } }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const draft = await requestReferenceLayout(image);
    expect(draft.components[0].id).toBe("legacy-wall");
  });

  it("rejects an explicit unsupported format even when a legacy draft is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      observationFormat: "image-observations-v2",
      draft: { components: [{ id: "legacy-wall", name: "墙", category: "wall", primitive: "box", position: [0, 0, -3], size: [6, 2.8, 0.15], rotationYDegrees: 0, confidence: 0.8 }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(requestReferenceLayout(image)).rejects.toThrow("不支持的图像观察格式");
  });

  it("shows the first safe structural issue returned by the Worker", async () => {
    await expect(
      rejectWithIssues(["第 1 个窗未依附任何墙面", "第 2 个组件无效"])
    ).rejects.toThrow(
      "图片模型未能返回可用的布景结构，请重试或更换参考图（第 1 个窗未依附任何墙面）"
    );
  });

  it("keeps the generic message when the Worker has no usable issue", async () => {
    await expect(rejectWithIssues()).rejects.toThrow(
      "图片模型未能返回可用的布景结构，请重试或更换参考图"
    );
  });

  it.each([
    "Authorization: Bearer secret-value",
    "unexpected <script>payload</script>",
    `异常内容${"x".repeat(181)}`,
  ])("falls back safely for sensitive or abnormal issue text: %s", async (issue) => {
    const error = await rejectWithIssues([issue]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "图片模型未能返回可用的布景结构，请重试或更换参考图"
    );
    expect((error as Error).message).not.toContain("secret-value");
  });
});

describe("complex furniture spatial review", () => {
  const acceptedDraft = {
    referenceCamera: { fitDiagnostics: { qualityStatus: "accepted" } },
  } as any;
  const wellCoveredItems = [
    { id: "table", category: "table", semanticType: "table", name: "餐桌", bbox: [0, 0, 0.2, 0.2], confidence: 0.9, visibility: "visible", supportId: "floor" },
    { id: "chair", category: "chair", semanticType: "chair", name: "餐椅", bbox: [0, 0, 0.2, 0.2], confidence: 0.9, visibility: "visible", supportId: "floor" },
    { id: "cabinet", category: "cabinet", semanticType: "cabinet", name: "柜子", bbox: [0, 0, 0.2, 0.2], confidence: 0.9, visibility: "visible", contactWallSide: "image_back" },
    { id: "chair2", category: "chair", semanticType: "chair", name: "第二把椅子", bbox: [0, 0, 0.2, 0.2], confidence: 0.9, visibility: "visible", supportId: "floor" },
  ];

  it("requests one spatial review for a sectional without footprint evidence despite sufficient overall coverage", () => {
    const observation = {
      items: [
        { id: "sofa", category: "sofa", semanticType: "sectional_sofa", name: "大型组合沙发", bbox: [0, 0, 0.5, 0.5], confidence: 0.98, visibility: "visible" },
        ...wellCoveredItems,
      ],
    } as any;
    expect(shouldRequestSpatialReview(observation, acceptedDraft)).toBe(true);
  });

  it("does not request a shape review when the sectional already has a reliable footprint", () => {
    const observation = {
      items: [
        { id: "sofa", category: "sofa", semanticType: "sectional_sofa", name: "组合沙发", bbox: [0, 0, 0.5, 0.5], confidence: 0.98, visibility: "visible", groundFootprints: [{ confidence: 0.8, outer: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] }] },
        ...wellCoveredItems,
      ],
    } as any;
    expect(shouldRequestSpatialReview(observation, acceptedDraft)).toBe(false);
  });

  it("does not classify a corner table as complex sofa geometry", () => {
    const observation = { items: wellCoveredItems } as any;
    expect(shouldRequestSpatialReview(observation, acceptedDraft)).toBe(false);
  });

  it("recognizes a Chinese combined sofa name when the older response omits category", () => {
    const observation = {
      items: [
        { id: "sofa", name: "转角组合沙发", semanticType: "unknown", bbox: [0, 0, 0.5, 0.5], confidence: 0.98, visibility: "visible" },
        ...wellCoveredItems,
      ],
    } as any;
    expect(shouldRequestSpatialReview(observation, acceptedDraft)).toBe(true);
  });

  it("does not override an explicit non-sofa category from the name", () => {
    const observation = {
      items: [
        { id: "prop", category: "prop", name: "sectional sofa label on a package", semanticType: "unknown", bbox: [0, 0, 0.5, 0.5], confidence: 0.98, visibility: "visible" },
        ...wellCoveredItems,
      ],
    } as any;
    expect(shouldRequestSpatialReview(observation, acceptedDraft)).toBe(false);
  });
});
