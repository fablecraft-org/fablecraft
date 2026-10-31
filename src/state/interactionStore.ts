import { create } from "zustand";

interface InteractionState {
  activeCardId: string | null;
  rememberedChildIds: Record<string, string>;
  rememberChild: (parentId: string, childId: string) => void;
  clearChildMemory: () => void;
  setActiveCardId: (cardId: string | null) => void;
}

export const useInteractionStore = create<InteractionState>((set) => ({
  activeCardId: null,
  rememberedChildIds: {},
  rememberChild: (parentId, childId) => set((state) => ({
    rememberedChildIds: { ...state.rememberedChildIds, [parentId]: childId },
  })),
  clearChildMemory: () => set({ rememberedChildIds: {} }),
  setActiveCardId: (cardId) => set({ activeCardId: cardId }),
}));
