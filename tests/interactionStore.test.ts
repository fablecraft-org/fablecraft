import { beforeEach, describe, expect, it } from "vitest";
import { useInteractionStore } from "../src/state/interactionStore";

describe("card visit history", () => {
  beforeEach(() => {
    useInteractionStore.setState({ activeCardId: null, previousCardIds: [], referencePath: null });
  });

  it("remembers distinct previous selections without changing history on repeated focus", () => {
    const { setActiveCardId } = useInteractionStore.getState();
    setActiveCardId("a");
    setActiveCardId("b");
    setActiveCardId("a");
    setActiveCardId("c");
    setActiveCardId("c");
    expect(useInteractionStore.getState().previousCardIds).toEqual(["a", "b"]);
  });

  it("distinguishes appearances of the same fixed id and canonicalizes an explicit edit selection", () => {
    const store = useInteractionStore;
    store.getState().setActiveCardId("a");
    const path = [{ cardId: "a", alias: false }, { cardId: "a", alias: true }];
    store.getState().setActiveAppearance(path);
    expect(store.getState().activeCardId).toBe("a");
    expect(store.getState().referencePath).toEqual(path);
    expect(store.getState().previousCardIds).toEqual([]);
    store.getState().setActiveCardId("a");
    expect(store.getState().referencePath).toBeNull();
    expect(store.getState().previousCardIds).toEqual([]);
  });

  it("clears visits without losing the active selection or child navigation memory", () => {
    const { setActiveCardId, rememberChild, clearCardVisitHistory } = useInteractionStore.getState();
    setActiveCardId("a");
    setActiveCardId("b");
    rememberChild("a", "b");
    clearCardVisitHistory();
    expect(useInteractionStore.getState().previousCardIds).toEqual([]);
    expect(useInteractionStore.getState().activeCardId).toBe("b");
    expect(useInteractionStore.getState().rememberedChildIds.a).toBe("b");
  });
});
