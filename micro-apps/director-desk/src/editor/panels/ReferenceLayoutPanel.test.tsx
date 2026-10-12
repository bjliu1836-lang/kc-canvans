import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { DIRECTOR_DESK_REFERENCE_IMAGES_EVENT } from "../io/hostBridge";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
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
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    undoStack: [],
  });
  useLayoutDraftPreviewStore.setState({ draft: null, selectedComponentId: null });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ draft: fixtureDraft }),
  })));
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
  expect(await screen.findByText("暂存预览 · 2 个组件")).toBeInTheDocument();
  expect(screen.getByText("待确认")).toBeInTheDocument();

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
  expect(await screen.findByText("暂存预览 · 2 个组件")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "全部保留" }));
  expect(screen.queryByText("待确认")).not.toBeInTheDocument();
  expect(screen.getByText("暂存预览 · 2 个组件")).toBeInTheDocument();

  // 手动修改后重新生成必须二次确认，确认前不发请求
  await user.click(screen.getByRole("button", { name: "重新生成" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已手动修改过当前预览");
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "保留修改" }));
  expect(screen.queryByText(/已手动修改过当前预览/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重新生成" }));
  await user.click(await screen.findByRole("button", { name: "仍要重新生成" }));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("暂存预览 · 2 个组件")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "删除待确认" }));
  expect(screen.getByText("暂存预览 · 1 个组件")).toBeInTheDocument();
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
  expect(await screen.findByText("暂存预览 · 2 个组件")).toBeInTheDocument();
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

it("shows category colors, hovers rows, focuses the viewport and snaps a floating component", async () => {
  const user = userEvent.setup();
  render(<ReferenceLayoutPanel />);
  act(() => {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_REFERENCE_IMAGES_EVENT, {
      detail: { images: [{ edgeId: "e", sourceNodeId: "n", imageUrl: "data:image/png;base64,aGVsbG8=", fileName: "room.png" }] },
    }));
  });

  await user.click(screen.getByRole("button", { name: "生成粗布景" }));
  expect(await screen.findByText("暂存预览 · 2 个组件")).toBeInTheDocument();

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
