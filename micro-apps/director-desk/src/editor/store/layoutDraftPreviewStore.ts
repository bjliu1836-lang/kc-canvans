import { create } from "zustand";
import type { LayoutDraft } from "../schema/layoutDraft";

const LAYOUT_DRAFT_STORAGE_KEY = "storyai-3d-director-layout-draft";
const LAYOUT_DRAFT_STORAGE_KEY_PREFIX = `${LAYOUT_DRAFT_STORAGE_KEY}:`;

interface PersistedLayoutDraftPreview {
  draft: LayoutDraft;
  draftEdited: boolean;
  selectedComponentId: string | null;
  selectedCharacterId: string | null;
}

interface LayoutDraftPreviewState {
  scopeId: string | null;
  draft: LayoutDraft | null;
  draftEdited: boolean;
  selectedComponentId: string | null;
  hoveredComponentId: string | null;
  selectedCharacterId: string | null;
  hoveredCharacterId: string | null;
  setDraft: (draft: LayoutDraft | null, options?: { edited?: boolean }) => void;
  setDraftEdited: (edited: boolean) => void;
  openScope: (scopeId: string | null | undefined) => void;
  discardDraft: () => void;
  /** 组件与人物的选中互斥：草稿编辑器同一时刻只展示一个。 */
  selectComponent: (id: string | null) => void;
  hoverComponent: (id: string | null) => void;
  selectCharacter: (id: string | null) => void;
  hoverCharacter: (id: string | null) => void;
}

function normalizeScopeId(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() || null : null;
}

function getInitialScopeId() {
  if (typeof window === "undefined") return null;
  try {
    return normalizeScopeId(new URLSearchParams(window.location.search).get("instanceId"));
  } catch {
    return null;
  }
}

function getStorageKey(scopeId: string | null) {
  return scopeId ? `${LAYOUT_DRAFT_STORAGE_KEY_PREFIX}${scopeId}` : LAYOUT_DRAFT_STORAGE_KEY;
}

function getStorage() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function isLayoutDraft(value: unknown): value is LayoutDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LayoutDraft>;
  return candidate.version === 1
    && typeof candidate.id === "string"
    && typeof candidate.sourceId === "string"
    && typeof candidate.sourceFileName === "string"
    && Array.isArray(candidate.components)
    && Array.isArray(candidate.characters);
}

function readPersistedPreview(scopeId: string | null): PersistedLayoutDraftPreview | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(getStorageKey(scopeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedLayoutDraftPreview>;
    if (!isLayoutDraft(parsed.draft)) return null;
    return {
      draft: parsed.draft,
      draftEdited: parsed.draftEdited === true,
      selectedComponentId: typeof parsed.selectedComponentId === "string" ? parsed.selectedComponentId : null,
      selectedCharacterId: typeof parsed.selectedCharacterId === "string" ? parsed.selectedCharacterId : null,
    };
  } catch {
    return null;
  }
}

function writePersistedPreview(scopeId: string | null, preview: PersistedLayoutDraftPreview | null) {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (preview) storage.setItem(getStorageKey(scopeId), JSON.stringify(preview));
    else storage.removeItem(getStorageKey(scopeId));
  } catch {
    // Keep the in-memory candidate usable if browser storage is unavailable or full.
  }
}

function createScopeState(scopeId: string | null) {
  const persisted = readPersistedPreview(scopeId);
  return {
    scopeId,
    draft: persisted?.draft ?? null,
    draftEdited: persisted?.draftEdited ?? false,
    selectedComponentId: persisted?.selectedComponentId ?? persisted?.draft.components[0]?.id ?? null,
    hoveredComponentId: null,
    selectedCharacterId: persisted?.selectedCharacterId ?? null,
    hoveredCharacterId: null,
  };
}

const initialScopeId = getInitialScopeId();

export const useLayoutDraftPreviewStore = create<LayoutDraftPreviewState>((set, get) => ({
  ...createScopeState(initialScopeId),
  setDraft: (draft, options) => {
    set((state) => {
      const componentSelectionValid = Boolean(
        draft && state.selectedComponentId && draft.components.some((component) => component.id === state.selectedComponentId)
      );
      const characterSelectionValid = Boolean(
        draft && state.selectedCharacterId && draft.characters.some((character) => character.id === state.selectedCharacterId)
      );

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

      const next = {
        draft,
        draftEdited: draft ? options?.edited ?? state.draftEdited : false,
        selectedComponentId: nextComponentId,
        hoveredComponentId: draft?.components.some((component) => component.id === state.hoveredComponentId)
          ? state.hoveredComponentId
          : null,
        selectedCharacterId: nextCharacterId,
        hoveredCharacterId: draft?.characters.some((character) => character.id === state.hoveredCharacterId)
          ? state.hoveredCharacterId
          : null,
      };
      writePersistedPreview(state.scopeId, draft ? {
        draft,
        draftEdited: next.draftEdited,
        selectedComponentId: nextComponentId,
        selectedCharacterId: nextCharacterId,
      } : null);
      return next;
    });
  },
  setDraftEdited: (draftEdited) => set((state) => {
    if (state.draft) {
      writePersistedPreview(state.scopeId, {
        draft: state.draft,
        draftEdited,
        selectedComponentId: state.selectedComponentId,
        selectedCharacterId: state.selectedCharacterId,
      });
    }
    return { draftEdited };
  }),
  openScope: (scopeId) => {
    const normalizedScopeId = normalizeScopeId(scopeId);
    if (get().scopeId === normalizedScopeId) return;
    set(createScopeState(normalizedScopeId));
  },
  discardDraft: () => get().setDraft(null),
  selectComponent: (selectedComponentId) => set((state) => {
    if (state.draft) {
      writePersistedPreview(state.scopeId, {
        draft: state.draft,
        draftEdited: state.draftEdited,
        selectedComponentId,
        selectedCharacterId: null,
      });
    }
    return { selectedComponentId, selectedCharacterId: null };
  }),
  hoverComponent: (hoveredComponentId) => set({ hoveredComponentId }),
  selectCharacter: (selectedCharacterId) => set((state) => {
    if (state.draft) {
      writePersistedPreview(state.scopeId, {
        draft: state.draft,
        draftEdited: state.draftEdited,
        selectedComponentId: null,
        selectedCharacterId,
      });
    }
    return { selectedCharacterId, selectedComponentId: null };
  }),
  hoverCharacter: (hoveredCharacterId) => set({ hoveredCharacterId }),
}));
