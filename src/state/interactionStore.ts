import { create } from "zustand";
import type { WorkspacePane } from "../domain/document/manuscriptLayout";
import type { AppearanceStep } from "../domain/document/references";

interface InteractionState {
  workspacePane: WorkspacePane;
  workspaceDialog: boolean;
  workspaceSplitFits: boolean;
  manuscriptLinkEligible: boolean;
  activeCardId: string | null;
  referencePath: AppearanceStep[] | null;
  setActiveAppearance: (path: AppearanceStep[]) => void;
  clearReferencePath: () => void;
  previousCardIds: string[];
  clearCardVisitHistory: () => void;
  rememberedChildIds: Record<string, string>;
  rememberChild: (parentId: string, childId: string) => void;
  clearChildMemory: () => void;
  setActiveCardId: (cardId: string | null) => void;
}

export const createInteractionStore = () => create<InteractionState>((set) => ({
  workspacePane: "tree",
  workspaceDialog: false,
  workspaceSplitFits: true,
  manuscriptLinkEligible: false,
  activeCardId: null,
  referencePath: null,
  clearReferencePath: () => set({ referencePath: null }),
  setActiveAppearance: (path) => set((state) => {
    const cardId = path[path.length - 1]?.cardId ?? null;
    return {
      activeCardId: cardId,
      referencePath: path.some((step) => step.alias) ? path : null,
      previousCardIds: state.activeCardId && state.activeCardId !== cardId
        ? [state.activeCardId, ...state.previousCardIds.filter((id) => id !== state.activeCardId)]
        : state.previousCardIds,
    };
  }),
  previousCardIds: [],
  clearCardVisitHistory: () => set({ previousCardIds: [] }),
  rememberedChildIds: {},
  rememberChild: (parentId, childId) => set((state) => ({
    rememberedChildIds: { ...state.rememberedChildIds, [parentId]: childId },
  })),
  clearChildMemory: () => set({ rememberedChildIds: {} }),
  setActiveCardId: (cardId) => set((state) => {
    if (cardId === state.activeCardId) {
      return state.referencePath ? { referencePath: null } : state;
    }

    return {
      activeCardId: cardId,
      referencePath: null,
      previousCardIds: state.activeCardId
        ? [state.activeCardId, ...state.previousCardIds.filter((id) => id !== state.activeCardId)]
        : state.previousCardIds,
    };
  }),
}));

export const useInteractionStore = createInteractionStore();
