import { create } from "zustand";
import type { LayoutDraft } from "../schema/layoutDraft";

interface LayoutDraftPreviewState {
  draft: LayoutDraft | null;
  selectedComponentId: string | null;
  hoveredComponentId: string | null;
  setDraft: (draft: LayoutDraft | null) => void;
  selectComponent: (id: string | null) => void;
  hoverComponent: (id: string | null) => void;
}

export const useLayoutDraftPreviewStore = create<LayoutDraftPreviewState>((set) => ({
  draft: null,
  selectedComponentId: null,
  hoveredComponentId: null,
  setDraft: (draft) => set((state) => ({
    draft,
    selectedComponentId: draft?.components.some((component) => component.id === state.selectedComponentId)
      ? state.selectedComponentId
      : draft?.components[0]?.id ?? null,
    hoveredComponentId: draft?.components.some((component) => component.id === state.hoveredComponentId)
      ? state.hoveredComponentId
      : null,
  })),
  selectComponent: (selectedComponentId) => set({ selectedComponentId }),
  hoverComponent: (hoveredComponentId) => set({ hoveredComponentId }),
}));
