import { beforeEach, expect, it, vi } from "vitest";
import type { LayoutDraft } from "../schema/layoutDraft";
import { useLayoutDraftPreviewStore } from "./layoutDraftPreviewStore";

const draftFixture: LayoutDraft = {
  version: 1,
  id: "draft_restore",
  sourceId: "image_restore",
  sourceFileName: "restore.png",
  createdAt: "2026-10-13T00:00:00.000Z",
  scale: {
    mode: "anchored",
    confidence: 0.72,
    anchorComponentId: "sofa_01",
    anchorWidthMeters: 2.36,
    anchorDimension: "width",
  },
  components: [{
    id: "sofa_01",
    name: "手动调整沙发",
    category: "sofa",
    primitive: "box",
    position: [1.37, 0.18, -0.64],
    size: [2.36, 0.91, 0.88],
    rotationYDegrees: 17,
    confidence: 0.66,
    uncertain: false,
    visible: true,
  }],
  characters: [{
    id: "char_01",
    name: "手动调整人物",
    position: [-0.72, 0.46, 0.31],
    height: 1.73,
    rotationYDegrees: -35,
    posture: "sit",
    bodyTypeHint: "female",
    confidence: 0.81,
    uncertain: false,
    visible: true,
  }],
};

beforeEach(() => {
  localStorage.clear();
  useLayoutDraftPreviewStore.setState({
    scopeId: null,
    draft: null,
    draftEdited: false,
    selectedComponentId: null,
    hoveredComponentId: null,
    selectedCharacterId: null,
    hoveredCharacterId: null,
  });
});

it("restores an edited semantic draft exactly when returning to its instance scope", () => {
  const store = useLayoutDraftPreviewStore.getState();
  store.openScope("desk_restore");
  useLayoutDraftPreviewStore.getState().setDraft(draftFixture, { edited: true });
  useLayoutDraftPreviewStore.getState().selectCharacter("char_01");

  expect(localStorage.getItem("storyai-3d-director-layout-draft:desk_restore")).not.toContain("data:image");

  useLayoutDraftPreviewStore.getState().openScope("desk_other");
  expect(useLayoutDraftPreviewStore.getState().draft).toBeNull();

  useLayoutDraftPreviewStore.getState().openScope("desk_restore");
  expect(useLayoutDraftPreviewStore.getState().draft).toEqual(draftFixture);
  expect(useLayoutDraftPreviewStore.getState().draftEdited).toBe(true);
  expect(useLayoutDraftPreviewStore.getState().selectedCharacterId).toBe("char_01");
});

it("keeps the in-memory draft when browser persistence fails", () => {
  useLayoutDraftPreviewStore.getState().openScope("desk_storage_failure");
  const storageSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  });

  useLayoutDraftPreviewStore.getState().setDraft(draftFixture, { edited: true });

  expect(useLayoutDraftPreviewStore.getState().draft).toEqual(draftFixture);
  expect(useLayoutDraftPreviewStore.getState().draftEdited).toBe(true);
  storageSpy.mockRestore();
});

it("removes only the current instance draft when explicitly discarded", () => {
  useLayoutDraftPreviewStore.getState().openScope("desk_a");
  useLayoutDraftPreviewStore.getState().setDraft(draftFixture);
  useLayoutDraftPreviewStore.getState().openScope("desk_b");
  useLayoutDraftPreviewStore.getState().setDraft({ ...draftFixture, id: "draft_b" });

  useLayoutDraftPreviewStore.getState().discardDraft();
  expect(useLayoutDraftPreviewStore.getState().draft).toBeNull();

  useLayoutDraftPreviewStore.getState().openScope("desk_a");
  expect(useLayoutDraftPreviewStore.getState().draft?.id).toBe("draft_restore");
});
