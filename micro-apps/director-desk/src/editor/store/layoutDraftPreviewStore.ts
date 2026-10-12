import { create } from "zustand";
import type { LayoutDraft } from "../schema/layoutDraft";

interface LayoutDraftPreviewState {
  draft: LayoutDraft | null;
  selectedComponentId: string | null;
  hoveredComponentId: string | null;
  selectedCharacterId: string | null;
  hoveredCharacterId: string | null;
  setDraft: (draft: LayoutDraft | null) => void;
  /** 组件与人物的选中互斥：草稿编辑器同一时刻只展示一个。 */
  selectComponent: (id: string | null) => void;
  hoverComponent: (id: string | null) => void;
  selectCharacter: (id: string | null) => void;
  hoverCharacter: (id: string | null) => void;
}

export const useLayoutDraftPreviewStore = create<LayoutDraftPreviewState>((set) => ({
  draft: null,
  selectedComponentId: null,
  hoveredComponentId: null,
  selectedCharacterId: null,
  hoveredCharacterId: null,
  setDraft: (draft) => set((state) => {
    const componentSelectionValid = Boolean(
      draft && state.selectedComponentId && draft.components.some((component) => component.id === state.selectedComponentId)
    );
    const characterSelectionValid = Boolean(
      draft && state.selectedCharacterId && draft.characters.some((character) => character.id === state.selectedCharacterId)
    );

    // 选中保留优先级：当前有效的人物选中 > 当前有效的组件选中 > 新草稿默认选中第一个组件。
    // 编辑草稿（同内容重设）不能把用户正在编辑的人物/组件选中弹回默认项。
    let nextComponentId: string | null;
    let nextCharacterId: string | null;
    if (characterSelectionValid) {
      nextCharacterId = state.selectedCharacterId;
      nextComponentId = null;
    } else if (componentSelectionValid) {
      nextComponentId = state.selectedComponentId;
      nextCharacterId = null;
    } else {
      nextComponentId = draft?.components[0]?.id ?? null;
      nextCharacterId = null;
    }

    return {
      draft,
      selectedComponentId: nextComponentId,
      hoveredComponentId: draft?.components.some((component) => component.id === state.hoveredComponentId)
        ? state.hoveredComponentId
        : null,
      selectedCharacterId: nextCharacterId,
      hoveredCharacterId: draft?.characters.some((character) => character.id === state.hoveredCharacterId)
        ? state.hoveredCharacterId
        : null,
    };
  }),
  selectComponent: (selectedComponentId) => set({ selectedComponentId, selectedCharacterId: null }),
  hoverComponent: (hoveredComponentId) => set({ hoveredComponentId }),
  selectCharacter: (selectedCharacterId) => set({ selectedCharacterId, selectedComponentId: null }),
  hoverCharacter: (hoveredCharacterId) => set({ hoveredCharacterId }),
}));
