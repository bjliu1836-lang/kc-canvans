import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the first structural issue returned by the Worker", async () => {
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
