import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLayoutDiagnosticRecords } from "./layoutDiagnostics";
import { requestReferenceLayout } from "./referenceLayoutClient";

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
        items: [],
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
    expect(record?.normalized.components.some((component) => component.id === "wall")).toBe(true);
    expect(JSON.stringify(record?.candidate)).not.toContain("cameraPosition");
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody.outputFormat).toBe("image-observations-v1");
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
