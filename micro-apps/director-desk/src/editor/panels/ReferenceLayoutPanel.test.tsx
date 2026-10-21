import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, DIRECTOR_DESK_SESSION_OPENED_EVENT } from "../io/hostBridge";
import { getUE4SeatedPelvisSupportHeight } from "../runtime/ue4Mannequin/ue4MannequinRig";
import { getCameraViewSnapshotFromShot } from "../schema/cameraGeometry";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
import { getReferenceImageFingerprint } from "./DraftComponentAssetGenerator";
import { ReferenceLayoutPanel } from "./ReferenceLayoutPanel";

const fixtureDraft = {
  scale: { mode: "estimated", confidence: 0.45 },
  components: [{
    id: "wall_01",
    name: "后墙",
    category: "wall",
    primitive: "box",
    position: [0, 0, -3],
    size: [6, 2.8, 0.15],
    rotationYDegrees: 0,
    confidence: 0.82,
    uncertain: false,
    notes: "后墙位置待确认",
  }, {
    id: "sofa_01",
    name: "沙发（估计）",
    category: "sofa",
    primitive: "box",
    position: [1, 0.6, 0],
    size: [2, 0.85, 0.9],
    rotationYDegrees: 0,
    confidence: 0.55,
    uncertain: true,
  }],
};

beforeEach(() => {
  localStorage.clear();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    undoStack: [],
    viewportFocusRequest: null,
  });
  useLayoutDraftPreviewStore.setState({
    scopeId: null,
    draft: null,
    draftEdited: false,
    selectedComponentId: null,
    hoveredComponentId: null,
    selectedCharacterId: null,
    hoveredCharacterId: null,
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: fixtureDraft }),
  })));
});

it("changes the private source fingerprint when the same reference node receives a new image URL", () => {
  expect(getReferenceImageFingerprint("data:image/png;base64,first")).not.toBe(getReferenceImageFingerprint("data:image/png;base64,second"));
  expect(getReferenceImageFingerprint(null)).toBe("missing");
});

it("edits a controlled layout fixture in preview and commits it as one generated batch", async () => {
  const user = userEvent.setup();
  const windowKeydown = vi.fn();
  window.addEventListener("keydown", windowKeydown);
  render(<ReferenceLayoutPanel />);

  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: {
        instanceId: "desk_fixture",
        images: [{
          edgeId: "edge_1",
          sourceNodeId: "image_node_1",
          imageUrl: "data:image/png;base64,aGVsbG8=",
          fileName: "客厅参考图.png",
        }],
      },
    }));
  });

  expect(await screen.findByAltText("当前粗布景参考图")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();
  expect(screen.getByText("待确认")).toBeInTheDocument();
  expect(screen.getByText("后墙位置待确认")).toBeInTheDocument();

  const positionX = screen.getByLabelText("位置 X");
  fireEvent.keyDown(positionX, { key: "Delete" });
  expect(windowKeydown).not.toHaveBeenCalled();
  fireEvent.change(positionX, { target: { value: "2.5" } });
  // 墙体按「层高 2.8m」预填高度锚点；切到宽度维度再做校正
  expect(screen.getByLabelText("已知高度（米）")).toHaveValue(2.8);
  expect(screen.getByText(/已按「层高」预填/)).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("锚定维度"), "width");
  fireEvent.change(screen.getByLabelText("已知宽度（米）"), { target: { value: "3" } });
  await user.click(screen.getByRole("button", { name: "校正" }));
  expect(screen.getByText("已按已知尺寸校正")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "添加到当前场景" }));
  await waitFor(() => expect(useDirectorStore.getState().project.layoutBatches).toHaveLength(1));
  const generated = useDirectorStore.getState().project.objects.filter((object) => object.layoutSource);
  expect(generated).toHaveLength(2);
  expect(generated[0]).toMatchObject({
    name: "后墙",
    transform: { position: [1.25, 0, -1.5], scale: [3, 1.4, 0.075] },
    layoutSource: { sourceId: "image_node_1", category: "wall" },
  });
  expect(useLayoutDraftPreviewStore.getState().draft).toBeNull();
  expect(useDirectorStore.getState().undoStack).toHaveLength(1);

  window.removeEventListener("keydown", windowKeydown);
});

it("shows and updates the effective appearance facing in the selected rotation field", async () => {
  const user = userEvent.setup();
  const components = fixtureDraft.components.map((component) => component.id === "sofa_01"
    ? { ...component, appearance: { frontDirectionDegrees: 90 } }
    : component);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ draft: { ...fixtureDraft, components } }) })));
  render(<ReferenceLayoutPanel />);
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
    detail: { instanceId: "effective-facing", images: [{ edgeId: "facing", sourceNodeId: "facing", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "room.png" }] },
  })));
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  await user.click(screen.getByRole("button", { name: /沙发（估计）/ }));

  const rotation = screen.getByLabelText("Y 轴旋转");
  expect(rotation).toHaveValue(90);
  fireEvent.change(rotation, { target: { value: "135" } });
  expect(useLayoutDraftPreviewStore.getState().draft?.components.find((component) => component.id === "sofa_01")?.appearance?.frontDirectionDegrees).toBe(135);
});

it("shows safe, user-facing explanations for spatial validation warnings", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: { ...fixtureDraft, relations: [{ fromId: "wall_01", toId: "wall_01", type: "unknown", confidence: 0.9 }] } }),
  })));
  render(<ReferenceLayoutPanel />);
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
    detail: { instanceId: "desk_warnings", images: [{ edgeId: "edge_warning", sourceNodeId: "image_warning", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "房间.png" }] },
  })));
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  const warning = await screen.findByRole("status", { name: "布景校验提示" });
  expect(within(warning).getByText("部分空间关系格式无效，已忽略。")).toBeInTheDocument();
});

it("keeps the inferred reference framing when applying from reference-camera preview", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: {
      ...fixtureDraft,
      referenceCamera: { projection: "perspective", position: [0, 2.1, 10], target: [0, 1.2, -2.8], fov: 48, confidence: 0.35, source: "model" },
    } }),
  })));
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: {
        instanceId: "desk_reference_camera",
        images: [{ edgeId: "edge_reference", sourceNodeId: "image_reference", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "寺庙.png" }],
      },
    }));
  });

  const referenceImage = await screen.findByAltText("当前粗布景参考图");
  Object.defineProperty(referenceImage, "naturalWidth", { configurable: true, value: 1600 });
  Object.defineProperty(referenceImage, "naturalHeight", { configurable: true, value: 900 });
  fireEvent.load(referenceImage);
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  const previewButton = screen.getByTitle("按同一推断机位查看可编辑草稿");
  await user.click(previewButton);
  expect(useDirectorStore.getState().referenceCameraPreview).toMatchObject({
    position: [0, 2.1, 10],
    target: [0, 1.2, -2.8],
    fov: 48,
    imageAspectRatio: 16 / 9,
  });
  expect(useDirectorStore.getState().viewMode).toBe("director");
  await user.click(screen.getByTitle("退出参考机位预览"));
  expect(useDirectorStore.getState().referenceCameraPreview).toBeNull();
  await user.click(screen.getByTitle("按同一推断机位查看可编辑草稿"));

  await user.click(screen.getByRole("button", { name: "添加到当前场景" }));
  await waitFor(() => expect(useDirectorStore.getState().viewMode).toBe("camera"));
  const state = useDirectorStore.getState();
  expect(state.referenceCameraPreview).toBeNull();
  expect(state.project.activeCameraId).toBe(state.project.layoutBatches?.[0]?.referenceCameraId);
  expect(state.project.cameras.find((camera) => camera.id === state.project.activeCameraId)).toMatchObject({
    fov: expect.any(Number),
    motionPath: { keyframes: [] },
  });
  const appliedCamera = state.project.cameras.find((camera) => camera.id === state.project.activeCameraId)!;
  expect(getCameraViewSnapshotFromShot(appliedCamera)).toMatchObject({
    position: [0, 2.1, 10],
    target: [0, 1.2, -2.8],
    fov: 48,
  });
});

it("uses user-facing estimated-framing copy without exposing internal projection thresholds", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: {
      ...fixtureDraft,
      referenceCamera: {
        projection: "perspective", position: [0, 2.1, 10], target: [0, 1.2, -2.8], fov: 48,
        confidence: 0.2, source: "estimated",
        fitDiagnostics: {
          qualityStatus: "needsReview", itemCount: 5, candidateCount: 500, applied: true,
          bestCandidate: { position: [0, 2.1, 10], target: [0, 1.2, -2.8], fov: 48 },
          baselineProjectionError: 0.8, bestProjectionError: 0.168, passedErrorThreshold: true,
          rejectionReason: null,
        },
      },
    } }),
  })));
  render(<ReferenceLayoutPanel />);
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
    detail: { instanceId: "desk_estimated_copy", images: [{ edgeId: "edge_estimated_copy", sourceNodeId: "image_estimated_copy", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "寺庙.png" }] },
  })));
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  expect(screen.getByText("参考取景 · 待确认")).toBeInTheDocument();
  expect(screen.getByText("已按原图估算视角与布局，请核对物品位置、比例和遮挡；可直接转动视角调整。")).toBeInTheDocument();
  expect(screen.queryByText(/bbox|0\.22|投影框误差/)).not.toBeInTheDocument();
});

it("shows dominant per-object residuals when reference-camera fitting fails its quality gate", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: {
      ...fixtureDraft,
      referenceCamera: {
        projection: "perspective", position: [0, 2.1, 10], target: [0, 1.2, -2.8], fov: 48,
        confidence: 0.2, source: "estimated",
        fitDiagnostics: {
          qualityStatus: "needsReview", itemCount: 5, candidateCount: 500, applied: true,
          bestCandidate: { position: [0, 2.1, 10], target: [0, 1.2, -2.8], fov: 48 },
          baselineProjectionError: 0.8, bestProjectionError: 0.31, passedErrorThreshold: false,
          rejectionReason: "error-too-high",
          pairDiagnostics: [
            { id: "sofa_01", observedCenter: [0.5, 0.5], observedSize: [0.4, 0.3], predictedCenter: [0.8, 0.6], predictedSize: [0.5, 0.4], centerError: 0.32, scaleError: 0.41, weightedContribution: 0.18 },
            { id: "wall_01", observedCenter: [0.5, 0.5], observedSize: [0.8, 0.7], predictedCenter: [0.5, 0.5], predictedSize: [0.3, 0.2], centerError: 0.01, scaleError: 1.12, weightedContribution: 0.09 },
            { id: "other", observedCenter: [0.2, 0.5], observedSize: [0.1, 0.2], predictedCenter: [0.2, 0.5], predictedSize: [0.1, 0.2], centerError: 0.01, scaleError: 0.01, weightedContribution: 0.02 },
          ],
        },
      },
    } }),
  })));
  render(<ReferenceLayoutPanel />);
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
    detail: { instanceId: "desk_residual_review", images: [{ edgeId: "edge_residual_review", sourceNodeId: "image_residual_review", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "reference.png" }] },
  })));
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  expect(screen.getByLabelText("参考机位残差待复核")).toHaveTextContent("沙发（估计）");
  expect(screen.getByLabelText("参考机位残差待复核")).toHaveTextContent("后墙");
  expect(screen.getByLabelText("参考机位残差待复核")).toHaveTextContent("未被自动改写");
});

it("clears a reference preview when the source image or Director Desk instance changes", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: fixtureDraft }),
  })));
  render(<ReferenceLayoutPanel />);
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
    detail: { instanceId: "desk_switch", images: [
      { edgeId: "edge_a", sourceNodeId: "image_a", imageUrl: "data:image/png;base64,AA==", fileName: "a.png" },
      { edgeId: "edge_b", sourceNodeId: "image_b", imageUrl: "data:image/png;base64,AA==", fileName: "b.png" },
    ] },
  })));
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  await user.click(screen.getByTitle("按同一推断机位查看可编辑草稿"));
  expect(useDirectorStore.getState().referenceCameraPreview).not.toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "选择粗布景参考图" }), { target: { value: "image_b" } });
  expect(useDirectorStore.getState().referenceCameraPreview).toBeNull();
  expect(useDirectorStore.getState().viewMode).toBe("director");

  await user.click(screen.getByTitle("按同一推断机位查看可编辑草稿"));
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_SESSION_OPENED_EVENT, { detail: { instanceId: "desk_next" } })));
  expect(useDirectorStore.getState().referenceCameraPreview).toBeNull();
  expect(useDirectorStore.getState().viewMode).toBe("director");
});

it("clears reference preview on panel unmount", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: fixtureDraft }),
  })));
  const { unmount } = render(<ReferenceLayoutPanel />);
  act(() => window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
    detail: { instanceId: "desk_unmount", images: [{ edgeId: "edge_unmount", sourceNodeId: "image_unmount", imageUrl: "data:image/png;base64,AA==", fileName: "unmount.png" }] },
  })));
  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  await user.click(screen.getByTitle("按同一推断机位查看可编辑草稿"));
  expect(useDirectorStore.getState().referenceCameraPreview).not.toBeNull();
  unmount();
  expect(useDirectorStore.getState().referenceCameraPreview).toBeNull();
  expect(useDirectorStore.getState().viewMode).toBe("director");
});

it("requires measured scale values for pillar and prop while preserving legacy category presets", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      draft: {
        ...fixtureDraft,
        components: [
          fixtureDraft.components[0],
          {
            ...fixtureDraft.components[0],
            id: "prop_01",
            name: "坐垫道具",
            category: "prop",
            size: [0.6, 0.12, 0.6],
          },
          {
            ...fixtureDraft.components[0],
            id: "pillar_01",
            name: "寺庙立柱",
            category: "pillar",
            size: [0.5, 4.2, 0.5],
          },
        ],
      },
    }),
  })));
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "temple.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByLabelText("已知高度（米）")).toHaveValue(2.8);

  await user.click(screen.getByRole("button", { name: /坐垫道具/ }));
  expect(screen.getByLabelText("已知高度（米）")).toHaveValue(null);
  expect(screen.getByRole("button", { name: "校正" })).toBeDisabled();
  expect(screen.getByText(/坐垫、供器或雕像.*请填写你确知的实测尺寸/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /寺庙立柱/ }));
  expect(screen.getByLabelText("已知高度（米）")).toHaveValue(null);
  expect(screen.getByRole("button", { name: "校正" })).toBeDisabled();
  expect(screen.getByText(/柱体高度差异较大.*请填写你确知的实测尺寸/)).toBeInTheDocument();
});

it("cancels an in-flight request without writing a draft or project objects", async () => {
  vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })));
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "https://example.com/room.png", fileName: "room.png" }] },
    }));
  });

  await user.click(await screen.findByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByRole("status")).toHaveTextContent("模型识别中");
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("已取消本次生成");
  expect(useLayoutDraftPreviewStore.getState().draft).toBeNull();
  expect(useDirectorStore.getState().project.objects.some((object) => object.layoutSource)).toBe(false);
});

it("keeps or drops every uncertain component with the batch actions", async () => {
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "room.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "全部保留" }));
  expect(screen.queryByText("待确认")).not.toBeInTheDocument();
  expect(screen.getByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();

  // 手动修改后重新生成必须二次确认，确认前不发请求
  await user.click(screen.getByRole("button", { name: "重新生成" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已手动修改过当前预览");
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "保留修改" }));
  expect(screen.queryByText(/已手动修改过当前预览/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重新生成" }));
  await user.click(await screen.findByRole("button", { name: "仍要重新生成" }));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "删除待确认" }));
  expect(screen.getByText(/待应用布景 · 1 个组件/)).toBeInTheDocument();
});

it("scales the applied batch around its center from the adjust section", async () => {
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "客厅参考图.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "添加到当前场景" }));

  const adjust = await screen.findByLabelText("布景整体调整");
  expect(within(adjust).getByText(/客厅参考图\.png/)).toBeInTheDocument();

  fireEvent.change(within(adjust).getByLabelText("整体缩放倍数"), { target: { value: "2" } });
  await user.click(within(adjust).getByRole("button", { name: "应用缩放" }));

  const wall = useDirectorStore.getState().project.objects.find((object) => object.name === "后墙");
  expect(wall?.transform.scale).toEqual([12, 5.6, 0.3]);
  expect(wall?.transform.position).toEqual([-0.5, 0, -4.5]);

  fireEvent.change(within(adjust).getByLabelText("整体平移 X"), { target: { value: "1" } });
  await user.click(within(adjust).getByRole("button", { name: "应用平移" }));
  expect(useDirectorStore.getState().project.objects.find((object) => object.name === "后墙")?.transform.position)
    .toEqual([0.5, 0, -4.5]);

  // 整批贴地：悬浮的沙发落回地面，已在地面上的墙保持不动
  const sofaBefore = useDirectorStore.getState().project.objects.find((object) => object.name === "沙发（估计）");
  expect(sofaBefore?.transform.position[1]).toBeCloseTo(0.6);
  await user.click(within(adjust).getByRole("button", { name: "整批贴地" }));
  const sofaAfter = useDirectorStore.getState().project.objects.find((object) => object.name === "沙发（估计）");
  expect(sofaAfter?.transform.position[1]).toBe(0);
  expect(useDirectorStore.getState().project.objects.find((object) => object.name === "后墙")?.transform.position[1])
    .toBe(0);
});

it("shows neutral category markers, hovers rows, focuses the viewport and snaps a floating component", async () => {
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "room.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();

  // 类别色标存在
  expect(document.querySelectorAll(".reference-layout-category-dot")).toHaveLength(2);

  // 悬停行 → 预览 store 记录悬停
  fireEvent.mouseEnter(screen.getByRole("button", { name: /沙发（估计）/ }));
  expect(useLayoutDraftPreviewStore.getState().hoveredComponentId).toBe("sofa_01");
  fireEvent.mouseLeave(screen.getByRole("button", { name: /沙发（估计）/ }));
  expect(useLayoutDraftPreviewStore.getState().hoveredComponentId).toBeNull();

  // 点击行 → 选中 + 相机聚焦请求
  expect(useDirectorStore.getState().viewportFocusRequest).toBeNull();
  await user.click(screen.getByRole("button", { name: /沙发（估计）/ }));
  expect(useLayoutDraftPreviewStore.getState().selectedComponentId).toBe("sofa_01");
  expect(useDirectorStore.getState().viewportFocusRequest).toMatchObject({ target: [1, 1.025, 0] });

  // 悬浮组件一键贴地
  expect(useLayoutDraftPreviewStore.getState().draft?.components.find((c) => c.id === "sofa_01")?.position[1]).toBe(0.6);
  await user.click(screen.getByRole("button", { name: "贴地" }));
  expect(useLayoutDraftPreviewStore.getState().draft?.components.find((c) => c.id === "sofa_01")?.position[1]).toBe(0);
});

it("shows the character section, edits a placeholder, and applies characters as roles", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      draft: {
        ...fixtureDraft,
        characters: [{
          id: "char_01",
          name: "人物甲",
          position: [1.2, 0, 0.4],
          height: 1.7,
          rotationYDegrees: 90,
          posture: "stand",
          bodyTypeHint: "male",
          confidence: 0.86,
          uncertain: false,
          visible: true,
        }, {
          id: "char_02",
          name: "人物乙",
          position: [0.2, 0.45, -0.1],
          height: 1.62,
          rotationYDegrees: 0,
          posture: "sit",
          bodyTypeHint: "female",
          confidence: 0.55,
          uncertain: true,
          visible: true,
        }],
      },
    }),
  })));
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "room.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();

  // 人物分区：两行、姿态与身高标签、待确认标记只属于人物乙
  const characters = screen.getByLabelText("人物占位");
  expect(within(characters).getByText(/人物 · 2 个/)).toBeInTheDocument();
  expect(within(characters).getByText(/站立 · 1\.70m · 86%/)).toBeInTheDocument();
  expect(within(characters).getByText(/坐姿 · 1\.62m · 55%/)).toBeInTheDocument();
  expect(within(characters).getAllByText("待确认")).toHaveLength(1);
  expect(document.querySelectorAll(".reference-layout-category-dot")).toHaveLength(4);

  // 悬停人物行 → 预览 store 记录悬停的人物
  fireEvent.mouseEnter(within(characters).getByRole("button", { name: /人物甲/ }));
  expect(useLayoutDraftPreviewStore.getState().hoveredCharacterId).toBe("char_01");
  fireEvent.mouseLeave(within(characters).getByRole("button", { name: /人物甲/ }));
  expect(useLayoutDraftPreviewStore.getState().hoveredCharacterId).toBeNull();

  // 点击人物行 → 选中人物（与组件选中互斥）+ 相机聚焦到人物中心
  act(() => { useDirectorStore.getState().clearViewportFocusRequest(); });
  expect(useDirectorStore.getState().viewportFocusRequest).toBeNull();
  await user.click(within(characters).getByRole("button", { name: /人物甲/ }));
  expect(useLayoutDraftPreviewStore.getState().selectedCharacterId).toBe("char_01");
  expect(useLayoutDraftPreviewStore.getState().selectedComponentId).toBeNull();
  expect(useDirectorStore.getState().viewportFocusRequest).toMatchObject({ target: [1.2, 0.85, 0.4] });

  // 人物编辑器：改身高、切姿态
  const heightInput = screen.getByLabelText("身高（米）");
  expect(heightInput).toHaveValue(1.7);
  fireEvent.change(heightInput, { target: { value: "1.8" } });
  expect(useLayoutDraftPreviewStore.getState().draft?.characters[0].height).toBe(1.8);

  await user.selectOptions(screen.getByLabelText("姿态"), "crouch");
  expect(useLayoutDraftPreviewStore.getState().draft?.characters[0].posture).toBe("crouch");

  // 应用：人物成为可编辑角色对象（含姿态与身高换算）
  await user.click(screen.getByRole("button", { name: "添加到当前场景" }));
  await waitFor(() => expect(useDirectorStore.getState().project.layoutBatches).toHaveLength(1));
  const createdRoles = useDirectorStore.getState().project.objects
    .filter((object) => object.kind === "character" && object.layoutSource);
  expect(createdRoles).toHaveLength(2);
  expect(createdRoles[0]).toMatchObject({
    name: "人物甲",
    bodyType: "mannequin",
    characterRig: { rigType: "ue4-mannequin", posePresetId: "crouch" },
    layoutSource: { category: "character", characterMeta: { posture: "crouch", height: 1.8 } },
  });
  expect(createdRoles[0].transform.position).toEqual([1.2, 0, 0.4]);
  expect(createdRoles[1]).toMatchObject({
    name: "人物乙",
    bodyType: "female",
    characterRig: { posePresetId: "sit" },
  });
  // 坐姿人物的骨盆座面锚点落在草稿给出的 0.45m 座面高度上
  expect(
    createdRoles[1].transform.position[1]
    + getUE4SeatedPelvisSupportHeight("female") * createdRoles[1].transform.scale[1],
  ).toBeCloseTo(0.45);
});

it("accepts a pasted screenshot or dropped file as the local reference image", async () => {
  const { container } = render(<ReferenceLayoutPanel />);
  const pastedFile = new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" });
  fireEvent.paste(document, { clipboardData: { files: [pastedFile] } });

  expect(await screen.findByAltText("当前粗布景参考图")).toBeInTheDocument();
  expect(screen.getAllByText("pasted.png").length).toBeGreaterThan(0);

  const droppedFile = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
  const panel = container.querySelector(".reference-layout-panel");
  expect(panel).not.toBeNull();
  fireEvent.drop(panel as Element, { dataTransfer: { files: [droppedFile] } });

  await waitFor(() => expect(screen.getAllByText("dropped.png").length).toBeGreaterThan(0));
});

it("opens the selected reference thumbnail with keyboard and closes the large viewer safely", async () => {
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: {
        images: [{
          edgeId: "e",
          sourceNodeId: "n",
          imageUrl: "data:image/png;base64,aGVsbG8=",
          fileName: "寺庙参考图.png",
        }],
      },
    }));
  });

  await user.selectOptions(screen.getByLabelText("选择粗布景参考图"), "n");
  const previewButton = await screen.findByRole("button", { name: "查看参考图大图：寺庙参考图.png" });
  previewButton.focus();
  await user.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", { name: "参考图查看器：寺庙参考图.png" });
  expect(within(dialog).getByAltText("寺庙参考图.png 大图")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭参考图查看器" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: /参考图查看器/ })).not.toBeInTheDocument();
  await waitFor(() => expect(previewButton).toHaveFocus());

  await user.click(previewButton);
  fireEvent.click(screen.getByRole("dialog", { name: "参考图查看器：寺庙参考图.png" }));
  expect(screen.queryByRole("dialog", { name: /参考图查看器/ })).not.toBeInTheDocument();
});

it("lets a generated kneeling character switch between explicit kneel variants", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      draft: {
        ...fixtureDraft,
        characters: [{
          id: "char_01",
          name: "祈祷女子",
          position: [0, 0.12, 0],
          height: 1.62,
          rotationYDegrees: -45,
          posture: "kneel",
          kneelVariant: "seiza",
          handGesture: "prayer",
          bodyTypeHint: "female",
          confidence: 0.88,
          uncertain: false,
          notes: "跪坐人物支撑高度待确认",
        }],
      },
    }),
  })));
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "temple.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/跪坐（臀落脚跟） · 1\.62m/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /祈祷女子/ }));
  const variant = screen.getByLabelText("跪姿细分");
  expect(variant).toHaveValue("seiza");
  expect(screen.getByLabelText("手势")).toHaveValue("prayer");
  expect(screen.getByText("跪坐人物支撑高度待确认")).toBeInTheDocument();
  await user.selectOptions(variant, "two-knee");
  expect(useLayoutDraftPreviewStore.getState().draft?.characters[0].kneelVariant).toBe("two-knee");
});

it("keeps a successful draft when the scene panel unmounts and discards it only from the explicit action", async () => {
  const user = userEvent.setup();
  const view = render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "room.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText(/待应用布景 · 2 个组件/)).toBeInTheDocument();
  const generatedDraft = useLayoutDraftPreviewStore.getState().draft;

  view.unmount();
  expect(useLayoutDraftPreviewStore.getState().draft).toEqual(generatedDraft);

  render(<ReferenceLayoutPanel />);
  expect(screen.getByRole("heading", { name: "待应用布景" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "丢弃草稿" }));
  expect(useLayoutDraftPreviewStore.getState().draft).toBeNull();
});
