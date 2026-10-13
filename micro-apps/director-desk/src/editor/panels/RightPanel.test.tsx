import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import type { LayoutDraft } from "../schema/layoutDraft";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { useLayoutDraftPreviewStore } from "../store/layoutDraftPreviewStore";
import { RightPanel } from "./RightPanel";

const pendingDraft: LayoutDraft = {
  version: 1,
  id: "pending_layout",
  sourceId: "fixture_image",
  sourceFileName: "fixture.png",
  createdAt: "2026-10-13T00:00:00.000Z",
  scale: { mode: "estimated", confidence: 0.5 },
  components: [{
    id: "chair_01",
    name: "椅子",
    category: "chair",
    primitive: "box",
    position: [0, 0, 0],
    size: [0.5, 0.9, 0.5],
    rotationYDegrees: 0,
    confidence: 0.8,
    uncertain: false,
    visible: true,
  }],
  characters: [{
    id: "char_01",
    name: "人物",
    position: [1, 0, 0],
    height: 1.7,
    rotationYDegrees: 0,
    posture: "stand",
    bodyTypeHint: "male",
    confidence: 0.8,
    uncertain: false,
    visible: true,
  }],
};

beforeEach(() => {
  localStorage.clear();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    undoStack: [],
  });
  useLayoutDraftPreviewStore.setState({
    scopeId: null,
    draft: pendingDraft,
    draftEdited: false,
    selectedComponentId: "chair_01",
    hoveredComponentId: null,
    selectedCharacterId: null,
    hoveredCharacterId: null,
  });
});

it("shows a persistent return entry in object panels and resumes the pending layout editor", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().selectObject("char_default_a");
  render(<RightPanel />);

  const resume = screen.getByRole("button", { name: "返回待应用布景" });
  expect(resume).toHaveTextContent("1 组件 / 1 人物");

  await user.click(resume);

  expect(screen.getByLabelText("3D场景右侧属性面板")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "待应用布景" })).toBeInTheDocument();
  expect(useLayoutDraftPreviewStore.getState().draft).toEqual(pendingDraft);
});
