import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    position: [1, 0, 0],
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
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("已取消本次生成");
  expect(useLayoutDraftPreviewStore.getState().draft).toBeNull();
  expect(useDirectorStore.getState().project.objects.some((object) => object.layoutSource)).toBe(false);
});
