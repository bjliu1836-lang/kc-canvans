import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { getImageTo3dJob, type ImageTo3dJobStatus } from "../io/imageTo3dClient";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { AssetImportPanel } from "./AssetImportPanel";

vi.mock("../io/imageTo3dClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../io/imageTo3dClient")>();
  return { ...actual, getImageTo3dJob: vi.fn() };
});

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:uploaded"),
  });
  sessionStorage.clear();
  vi.mocked(getImageTo3dJob).mockReset();
});

it("renders the single-object generation controls in the model-library panel", () => {
  render(<AssetImportPanel />);

  expect(screen.getByLabelText("3D生成服务访问码")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("单物体图片")).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
  expect(screen.getByRole("button", { name: "生成单物体 3D 模型" })).toBeDisabled();
  expect(screen.queryByText("导入本地模型")).not.toBeInTheDocument();
});

const providerStatusCases: Array<{
  state: ImageTo3dJobStatus["state"];
  phase: string;
  error?: string;
  expected: string;
}> = [
  {
    state: "unknown",
    phase: "generating",
    expected: "提交状态不确定，系统不会自动重试；远端任务可能仍在运行，20分钟保护期后可再试",
  },
  { state: "processing", phase: "saving-result", expected: "正在保存生成结果…" },
  { state: "failed", phase: "connecting", error: "PROVIDER_CONNECT_FAILED", expected: "连接3D生成服务失败，请检查服务状态后重试" },
  { state: "processing", phase: "provider-custom-phase", expected: "任务正在处理…" },
];

it.each(providerStatusCases)("shows the persisted terminal or effective provider phase: $state/$phase", async ({ state, phase, error, expected }) => {
  const credentials = { id: "job-id", jobCapability: "j".repeat(43), assetCapability: "a".repeat(43) };
  sessionStorage.setItem("KC_IMAGE_TO_3D_JOB", JSON.stringify({ credentials, inputName: "single-object.png" }));
  vi.mocked(getImageTo3dJob).mockResolvedValue({
    id: credentials.id,
    state,
    phase,
    createdAt: 1,
    updatedAt: 2,
    deadlineAt: 3,
    inputName: "single-object.png",
    ...(error ? { error } : {}),
  } as ImageTo3dJobStatus);

  render(<AssetImportPanel />);

  await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
});
