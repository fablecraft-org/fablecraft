import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkspace } from "../src/components/DocumentWorkspace";
import {
  contentJsonForPlainText,
  contentText,
  isContentEffectivelyEmpty,
  replaceCardContent,
} from "../src/domain/document/content";
import { NEW_CARD_EDITOR_DOCUMENT_JSON } from "../src/domain/document/editorDocument";
import { dispatchNativeMenuAction } from "../src/lib/nativeMenu";
import { useAppStore } from "../src/state/appStore";
import { useDocumentStore } from "../src/state/documentStore";
import { useInteractionStore } from "../src/state/interactionStore";
import { makeDocumentSnapshot } from "./documentSnapshotFactory";

const loadCurrentDocumentSnapshot = vi.fn();

vi.mock("../src/storage/documentSnapshots", () => ({
  loadCurrentDocumentSnapshot: () => loadCurrentDocumentSnapshot(),
}));

vi.mock("../src/storage/useDocumentAutosave", () => ({
  useDocumentAutosave: () => {},
}));

vi.mock("../src/storage/useExternalDocumentReload", () => ({
  useExternalDocumentReload: () => {},
}));

vi.mock("../src/components/CardEditor", () => ({
  CardEditor: ({
    focusPlacement,
    isEditing,
    onCreateSiblingBelow,
    onDeleteEmpty,
    onNavigateAbove,
    onNavigateChild,
    placeholder,
    pendingTextInput,
  }: {
    focusPlacement?: string | null;
    isEditing: boolean;
    onCreateSiblingBelow?: () => void;
    onDeleteEmpty?: () => void;
    onNavigateAbove?: (placement?: "start" | "end") => boolean;
    onNavigateChild?: (placement?: "start" | "end") => boolean;
    placeholder?: string;
    pendingTextInput?: string | null;
  }) => (
    <div>
      <div
        data-editing={String(isEditing)}
        data-focus-placement={focusPlacement ?? ""}
        data-placeholder={placeholder ?? ""}
        data-pending-text-input={pendingTextInput ?? ""}
        data-testid="card-editor"
      />
      <button data-testid="card-editor-create-sibling-below" onClick={() => onCreateSiblingBelow?.()} type="button" />
      <button data-testid="card-editor-delete-empty" onClick={() => onDeleteEmpty?.()} type="button" />
      <button data-testid="card-editor-navigate-above" onClick={() => onNavigateAbove?.()} type="button" />
      <button data-testid="card-editor-navigate-child-end" onClick={() => onNavigateChild?.("end")} type="button" />
    </div>
  ),
}));

vi.mock("../src/components/TreeCardButton", () => ({
  TreeCardButton: ({
    cardLabel,
    contentJson,
    isActive,
    onClick,
    placeholder,
    scale,
    titleOnly,
    x,
    y,
  }: {
    cardLabel?: string;
    contentJson?: string;
    isActive?: boolean;
    onClick?: () => void;
    placeholder?: string;
    scale?: number;
    titleOnly?: boolean;
    x?: number;
    y?: number;
  }) => (
    <div
      data-card-label={cardLabel ?? ""}
      data-content-json={contentJson ?? ""}
      data-is-active={String(Boolean(isActive))}
      data-placeholder={placeholder ?? ""}
      data-scale={String(scale ?? "")}
      data-title-only={String(Boolean(titleOnly))}
      data-x={String(x ?? "")}
      data-y={String(y ?? "")}
      data-testid="tree-card"
      onClick={onClick}
    />
  ),
}));

class ResizeObserverMock {
  disconnect() {}

  observe() {}

  takeRecords() {
    return [];
  }

  unobserve() {}
}

function resetStores() {
  useAppStore.setState({
    activeDocument: null,
    mode: "navigation",
    notice: null,
    screen: "workspace",
  });
  useDocumentStore.setState({
    dirty: false,
    editingFuture: [],
    editingPast: [],
    errorMessage: null,
    lastSavedAtMs: null,
    navigationFuture: [],
    navigationPast: [],
    saveState: "idle",
    snapshot: null,
  });
  useInteractionStore.setState({
    activeCardId: null,
  });
}

function mockLayoutHeight(heightForElement: (element: HTMLElement) => number) {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return heightForElement(this as HTMLElement);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return heightForElement(this as HTMLElement);
    },
  });
}

describe("DocumentWorkspace", () => {
  const originalActEnvironment = (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    loadCurrentDocumentSnapshot.mockReset();
    resetStores();
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    }
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
    }
    document.body.innerHTML = "";
    resetStores();
  });

  it("keeps the active card shell footprint stable between navigation and editing", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigationShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;
    const navigationEditor = container.querySelector(
      '[data-testid="card-editor"]',
    ) as HTMLDivElement | null;

    expect(navigationShell).not.toBeNull();
    expect(navigationEditor?.dataset.editing).toBe("false");
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);
    expect(navigationShell?.textContent).toContain("A01");

    const navigationStyle = {
      backgroundColor: navigationShell?.style.backgroundColor,
      borderWidth: navigationShell?.style.borderWidth,
      boxShadow: navigationShell?.style.boxShadow,
      minHeight: navigationShell?.style.minHeight,
      paddingBottom: navigationShell?.style.paddingBottom,
      paddingLeft: navigationShell?.style.paddingLeft,
      paddingRight: navigationShell?.style.paddingRight,
      paddingTop: navigationShell?.style.paddingTop,
    };

    await act(async () => {
      useAppStore.setState({ mode: "editing" });
    });

    const editingShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;
    const editingEditor = container.querySelector(
      '[data-testid="card-editor"]',
    ) as HTMLDivElement | null;

    expect(editingShell).not.toBeNull();
    expect(editingEditor?.dataset.editing).toBe("true");
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);
    expect({
      minHeight: editingShell?.style.minHeight,
      paddingBottom: editingShell?.style.paddingBottom,
      paddingLeft: editingShell?.style.paddingLeft,
      paddingRight: editingShell?.style.paddingRight,
      paddingTop: editingShell?.style.paddingTop,
    }).toEqual({
      minHeight: navigationStyle.minHeight,
      paddingBottom: navigationStyle.paddingBottom,
      paddingLeft: navigationStyle.paddingLeft,
      paddingRight: navigationStyle.paddingRight,
      paddingTop: navigationStyle.paddingTop,
    });
    expect(navigationStyle.backgroundColor).toBe(
      "var(--fc-color-card-surface-active)",
    );
    expect(navigationStyle.boxShadow).toBe("var(--fc-shadow-elevated)");
    expect(editingShell?.style.backgroundColor).toBe(
      "var(--fc-color-card-surface-editing)",
    );
    expect(editingShell?.style.borderWidth).toBe(navigationStyle.borderWidth);
    expect(editingShell?.style.boxShadow).toBe(navigationStyle.boxShadow);
    expect(editingShell?.style.paddingTop).toBe("40px");
    expect(Array.from(container.querySelectorAll('[data-testid="tree-card"]')).map((node) =>
      (node as HTMLDivElement).dataset.cardLabel,
    )).toEqual(["B01", "B02"]);

    await act(async () => {
      root.unmount();
    });
  });

  it("balances active card padding around a new empty heading card", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-a",
      contentJson: NEW_CARD_EDITOR_DOCUMENT_JSON,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const activeShell = container.querySelector(
      '[data-testid="active-card-shell"]',
    ) as HTMLDivElement | null;

    expect(activeShell?.style.paddingTop).toBe("33px");
    expect(activeShell?.style.paddingBottom).toBe("33px");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Cmd/Ctrl minus and plus to enter and exit title-only overview", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene\n\nBody copy"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const stage = container.querySelector(
      '[data-testid="document-stage"]',
    ) as HTMLDivElement | null;

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 140,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 600,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(overviewCards).toHaveLength(3);
    expect(overviewCards.every((card) => card.dataset.titleOnly === "true")).toBe(true);
    const overviewConnectors = Array.from(
      container.querySelectorAll('[data-testid="overview-connector"]'),
    );
    expect(overviewConnectors).toHaveLength(2);
    expect(overviewConnectors.every((connector) =>
      connector.getAttribute("stroke") === "var(--fc-color-overview-connector-active)",
    )).toBe(true);
    expect(overviewConnectors.every((connector) =>
      connector.getAttribute("data-highlighted") === "true",
    )).toBe(true);
    expect(overviewConnectors[0]?.hasAttribute("stroke-opacity")).toBe(false);
    expect(overviewConnectors[0]?.getAttribute("stroke-width")).toBe(
      "4.5",
    );
    const initialOverviewScale = overviewCards[0]?.dataset.scale;
    expect(overviewCards.find((card) => card.dataset.isActive === "true")?.dataset.x).toBe("0");
    expect(overviewCards.find((card) => card.dataset.isActive === "true")?.dataset.y).toBe("0");

    await act(async () => {
      overviewCards[1]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("navigation");

    const selectedOverviewCard = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.isActive === "true") as
      | HTMLDivElement
      | undefined;

    expect(selectedOverviewCard?.dataset.cardLabel).toBe("B01");
    expect(selectedOverviewCard?.dataset.scale).toBe(initialOverviewScale);
    expect(selectedOverviewCard?.dataset.x).toBe("0");
    expect(selectedOverviewCard?.dataset.y).toBe("0");
    const connectorsAfterSelection = Array.from(
      container.querySelectorAll('[data-testid="overview-connector"]'),
    );
    const parentConnector = connectorsAfterSelection.find(
      (connector) => connector.getAttribute("data-child-card-id") === "card-a",
    );
    const siblingConnector = connectorsAfterSelection.find(
      (connector) => connector.getAttribute("data-child-card-id") === "card-b",
    );

    expect(parentConnector?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(parentConnector?.getAttribute("data-highlighted")).toBe("true");
    expect(siblingConnector?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector)",
    );
    expect(siblingConnector?.getAttribute("data-highlighted")).toBe("false");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tree-card"]')).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
  });

  it("darkens overview connectors through the selected card descendant subtree", async () => {
    const baseSnapshot = makeDocumentSnapshot();
    const snapshot = {
      ...baseSnapshot,
      cards: [
        ...baseSnapshot.cards,
        {
          documentId: "doc-1",
          id: "card-a-1",
          orderIndex: 0,
          parentId: "card-a",
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-a-1-1",
          orderIndex: 0,
          parentId: "card-a-1",
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
        {
          cardId: "card-a-1",
          contentJson: contentJsonForPlainText("Nested Branch"),
        },
        {
          cardId: "card-a-1-1",
          contentJson: contentJsonForPlainText("Deep Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const connectors = Array.from(
      container.querySelectorAll('[data-testid="overview-connector"]'),
    );
    const connectorForChild = (cardId: string) =>
      connectors.find(
        (connector) => connector.getAttribute("data-child-card-id") === cardId,
      );

    expect(connectorForChild("card-a")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(connectorForChild("card-a-1")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(connectorForChild("card-a-1-1")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector-active)",
    );
    expect(connectorForChild("card-b")?.getAttribute("stroke")).toBe(
      "var(--fc-color-overview-connector)",
    );
    expect(connectorForChild("card-a-1-1")?.getAttribute("data-highlighted")).toBe(
      "true",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("pans the overview graph during wheel gestures without changing focus", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const stage = container.querySelector(
      '[data-testid="document-stage"]',
    ) as HTMLDivElement | null;

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const activeOverviewCard = () =>
      Array.from(container.querySelectorAll('[data-testid="tree-card"]')).find(
        (card) => (card as HTMLDivElement).dataset.isActive === "true",
      ) as HTMLDivElement | undefined;

    const initialScale = activeOverviewCard()?.dataset.scale;

    await act(async () => {
      stage?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 48,
          deltaY: 12,
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(activeOverviewCard()?.dataset.scale).toBe(initialScale);
    expect(activeOverviewCard()?.dataset.x).toBe("-48");
    expect(activeOverviewCard()?.dataset.y).toBe("-12");
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(
      (container.querySelector('[data-testid="overview-connectors"]') as SVGElement | null)
        ?.style.transform,
    ).toBe("translate(-48px, -12px)");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the fixed overview scale instead of deriving scale from the current full-card height", async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const element = this as HTMLElement;
      const isActiveShell = element.dataset.testid === "active-card-shell";

      return {
        bottom: isActiveShell ? 1200 : 84,
        height: isActiveShell ? 1200 : 84,
        left: 0,
        right: 468,
        toJSON() {
          return {};
        },
        top: 0,
        width: 468,
        x: 0,
        y: 0,
      } as DOMRect;
    };

    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Very Tall Root"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const activeOverviewCard = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.isActive === "true") as
      | HTMLDivElement
      | undefined;

    expect(activeOverviewCard?.dataset.scale).toBe("0.82");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const nextActiveOverviewCard = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.isActive === "true") as
      | HTMLDivElement
      | undefined;

    expect(nextActiveOverviewCard?.dataset.scale).toBe("0.82");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Enter in overview to return to the normal view on the selected card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    expect(overviewCards).toHaveLength(3);

    await act(async () => {
      overviewCards[2]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");
    expect(useAppStore.getState().mode).toBe("navigation");
    expect(container.querySelector('[data-testid="card-editor"]')?.getAttribute("data-editing")).toBe("false");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses native zoom menu actions to enter and exit overview", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      dispatchNativeMenuAction("zoom-out");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('[data-testid="tree-card"]')).every(
        (card) => (card as HTMLDivElement).dataset.titleOnly === "true",
      ),
    ).toBe(true);

    await act(async () => {
      dispatchNativeMenuAction("zoom-in");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('[data-testid="tree-card"]')).every(
        (card) => (card as HTMLDivElement).dataset.titleOnly === "false",
      ),
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("allows zoom menu actions while the command palette is open", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("First Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Second Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "command",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      dispatchNativeMenuAction("zoom-out");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).toBeNull();
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      useAppStore.setState({ mode: "command" });
    });

    await act(async () => {
      dispatchNativeMenuAction("zoom-in");
    });

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("remeasures a card selected in overview before restoring normal sibling spacing", async () => {
    mockLayoutHeight((element) => {
      const activeCardId = useInteractionStore.getState().activeCardId;

      return element.dataset.testid === "active-card-shell" && activeCardId === "card-a"
        ? 420
        : 84;
    });

    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Tall Branch"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Following Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    await act(async () => {
      overviewCards[1]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    const inactiveCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];
    const followingSibling = inactiveCards.find(
      (card) => card.dataset.cardLabel === "B02",
    );

    expect(container.querySelector('[data-testid="active-card-shell"]')).not.toBeNull();
    expect(followingSibling?.dataset.y).toBe("281");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses content height estimates for neighbors when returning from overview", async () => {
    const longText =
      "A long neighboring card that should reserve more than the minimum card height. " +
      "It has enough prose to wrap across several lines before the DOM measurement arrives, " +
      "so the restored normal view should not pack it like a tiny overview card.";
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root Scene"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText(longText),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Focused Branch"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "-",
          metaKey: true,
        }),
      );
    });

    const overviewCards = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ) as HTMLDivElement[];

    await act(async () => {
      overviewCards[2]?.click();
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "=",
          metaKey: true,
        }),
      );
    });

    const previousSibling = Array.from(
      container.querySelectorAll('[data-testid="tree-card"]'),
    ).find((card) => (card as HTMLDivElement).dataset.cardLabel === "B01") as
      | HTMLDivElement
      | undefined;

    expect(Number(previousSibling?.dataset.y)).toBeLessThan(-180);

    await act(async () => {
      root.unmount();
    });
  });

  it("suspends workspace keyboard navigation while an overlay is open", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(
        <DocumentWorkspace
          document={snapshot.summary}
          suspendKeyboard
        />,
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Shift+Right to indent the active card under the sibling above", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
          shiftKey: true,
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const cardAChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-a")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren?.map((card) => card.id)).toEqual(["card-a"]);
    expect(cardAChildren?.map((card) => card.id)).toEqual(["card-b"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      root.unmount();
    });
  });

  it("deletes an empty second root card on Backspace and keeps the first root placeholder semantics", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-root-2",
          orderIndex: 1,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Hello World"),
        },
        {
          cardId: "card-root-2",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root-2",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const deleteButton = container.querySelector(
      '[data-testid="card-editor-delete-empty"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      deleteButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");

    await act(async () => {
      root.unmount();
    });
  });

  it("deletes an empty root-level card when Escape leaves editing", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-root-2",
          orderIndex: 1,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Hello World"),
        },
        {
          cardId: "card-root-2",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root-2",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("returns to the parent after Backspace deletes an empty child card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Parent"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Existing child"),
        },
        {
          cardId: "card-b",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const deleteButton = container.querySelector(
      '[data-testid="card-editor-delete-empty"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      deleteButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual([
      "card-root",
      "card-a",
    ]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("returns to the parent after Escape deletes an empty child card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Parent"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Existing child"),
        },
        {
          cardId: "card-b",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual([
      "card-root",
      "card-a",
    ]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("trims a trailing empty line when Escape leaves a non-empty card", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-root",
      contentJson: JSON.stringify({
        content: [
          { content: [{ text: "Keep", type: "text" }], type: "paragraph" },
          { type: "paragraph" },
        ],
        type: "doc",
      }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    const nextContentJson =
      useDocumentStore
        .getState()
        .snapshot?.contents.find((content) => content.cardId === "card-root")
        ?.contentJson ?? "";

    expect(contentText(nextContentJson)).toBe("Keep");
    expect(JSON.parse(nextContentJson)).toEqual({
      content: [
        { content: [{ text: "Keep", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    });
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("deletes an empty root-level card before ArrowUp moves editing to the previous root card", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
        {
          documentId: "doc-1",
          id: "card-root-2",
          orderIndex: 1,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Hello World"),
        },
        {
          cardId: "card-root-2",
          contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root-2",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigateAboveButton = container.querySelector(
      '[data-testid="card-editor-navigate-above"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      navigateAboveButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-root");
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("trims the current card before edit-mode navigation focuses a child", async () => {
    const snapshot = replaceCardContent(makeDocumentSnapshot(), {
      cardId: "card-root",
      contentJson: JSON.stringify({
        content: [
          { content: [{ text: "Root", type: "text" }], type: "paragraph" },
          { type: "paragraph" },
        ],
        type: "doc",
      }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigateChildEndButton = container.querySelector(
      '[data-testid="card-editor-navigate-child-end"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      navigateChildEndButton?.click();
    });

    const nextContentJson =
      useDocumentStore
        .getState()
        .snapshot?.contents.find((content) => content.cardId === "card-root")
        ?.contentJson ?? "";

    expect(contentText(nextContentJson)).toBe("Root");
    expect(JSON.parse(nextContentJson)).toEqual({
      content: [
        { content: [{ text: "Root", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    });
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps edit mode and places focus at the end after Tab+ArrowRight navigates to a child", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Root"),
        },
        {
          cardId: "card-a",
          contentJson: contentJsonForPlainText("Child"),
        },
        {
          cardId: "card-b",
          contentJson: contentJsonForPlainText("Sibling"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const navigateChildEndButton = container.querySelector(
      '[data-testid="card-editor-navigate-child-end"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      navigateChildEndButton?.click();
    });

    const editor = container.querySelector(
      '[data-testid="card-editor"]',
    ) as HTMLElement | null;

    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.dataset.focusPlacement).toBe("end");

    await act(async () => {
      root.unmount();
    });
  });

  it("creates and focuses a sibling below from edit-mode Tab+ArrowDown fallback", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Last scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const createSiblingBelowButton = container.querySelector(
      '[data-testid="card-editor-create-sibling-below"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      createSiblingBelowButton?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const newCardId = useInteractionStore.getState().activeCardId;
    const editor = container.querySelector('[data-testid="card-editor"]');

    expect(rootChildren).toHaveLength(3);
    expect(rootChildren?.[2]?.id).toBe(newCardId);
    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.getAttribute("data-focus-placement")).toBe("end");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the final remaining card and empties it when deleting in navigation mode", async () => {
    const snapshot = {
      ...makeDocumentSnapshot(),
      cards: [
        {
          documentId: "doc-1",
          id: "card-root",
          orderIndex: 0,
          parentId: null,
          type: "card" as const,
        },
      ],
      contents: [
        {
          cardId: "card-root",
          contentJson: contentJsonForPlainText("Only card"),
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-root",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Backspace",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;

    expect(nextSnapshot?.cards.map((card) => card.id)).toEqual(["card-root"]);
    expect(
      isContentEffectivelyEmpty(nextSnapshot?.contents[0]?.contentJson ?? ""),
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Shift+Down to move a nested card into the next parent group in the same column", async () => {
    let snapshot = makeDocumentSnapshot();
    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Act one"),
    });
    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Act two"),
    });
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.concat(
        {
          documentId: "doc-1",
          id: "card-a-1",
          orderIndex: 0,
          parentId: "card-a",
          type: "card",
        },
        {
          documentId: "doc-1",
          id: "card-b-1",
          orderIndex: 0,
          parentId: "card-b",
          type: "card",
        },
      ),
      contents: snapshot.contents.concat(
        {
          cardId: "card-a-1",
          contentJson: contentJsonForPlainText("Beat one"),
        },
        {
          cardId: "card-b-1",
          contentJson: contentJsonForPlainText("Beat two"),
        },
      ),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a-1",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
          shiftKey: true,
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const cardAChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-a")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const cardBChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-b")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(cardAChildren).toHaveLength(0);
    expect(cardBChildren?.map((card) => [card.id, card.orderIndex])).toEqual([
      ["card-b-1", 0],
      ["card-a-1", 1],
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Option+Up to merge the sibling above into the active card", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          altKey: true,
          bubbles: true,
          key: "ArrowUp",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren?.map((card) => card.id)).toEqual(["card-b"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-b");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Option+Down to merge the sibling below into the active card", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          altKey: true,
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren?.map((card) => card.id)).toEqual(["card-a"]);
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");

    await act(async () => {
      root.unmount();
    });
  });

  it("starts editing and forwards the typed character when text is pressed in navigation mode", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "a",
        }),
      );
    });

    const editor = container.querySelector('[data-testid="card-editor"]');

    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.getAttribute("data-pending-text-input")).toBe("a");
    expect(editor?.getAttribute("data-focus-placement")).toBe("end");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an italic empty-card placeholder only after leaving editing empty", async () => {
    const snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "editing",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    let editor = container.querySelector('[data-testid="card-editor"]');

    expect(editor?.getAttribute("data-placeholder")).toBe("");

    await act(async () => {
      useAppStore.setState({ mode: "navigation" });
    });

    editor = container.querySelector('[data-testid="card-editor"]');

    expect(editor?.getAttribute("data-placeholder")).toBe("empty card");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Tab+ArrowDown to create a sibling below and focus it in edit mode", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);
    const newCardId = useInteractionStore.getState().activeCardId;
    const editor = container.querySelector('[data-testid="card-editor"]');

    expect(rootChildren).toHaveLength(3);
    expect(rootChildren?.[1]?.id).toBe(newCardId);
    expect(useAppStore.getState().mode).toBe("editing");
    expect(editor?.getAttribute("data-focus-placement")).toBe("end");
    expect(editor?.getAttribute("data-placeholder")).toBe("");

    await act(async () => {
      root.unmount();
    });
  });

  it("lets Cmd+ArrowDown fall through without creating a sibling", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-a",
      contentJson: contentJsonForPlainText("Scene"),
    });

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-a",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
          metaKey: true,
        }),
      );
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const rootChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-root")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(rootChildren).toHaveLength(2);
    expect(useInteractionStore.getState().activeCardId).toBe("card-a");
    expect(useAppStore.getState().mode).toBe("navigation");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders an empty child gap for a selected card without children and uses it to create a child", async () => {
    let snapshot = makeDocumentSnapshot();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    snapshot = replaceCardContent(snapshot, {
      cardId: "card-b",
      contentJson: contentJsonForPlainText("Scene"),
    });
    snapshot = {
      ...snapshot,
      cards: snapshot.cards.concat({
        documentId: "doc-1",
        id: "card-a-1",
        orderIndex: 0,
        parentId: "card-a",
        type: "card",
      }),
      contents: snapshot.contents.concat({
        cardId: "card-a-1",
        contentJson: contentJsonForPlainText("Beat"),
      }),
    };

    useDocumentStore.getState().hydrateSnapshot(snapshot);
    useAppStore.setState({
      activeDocument: snapshot.summary,
      mode: "navigation",
      notice: null,
      screen: "workspace",
    });
    useInteractionStore.setState({
      activeCardId: "card-b",
    });
    loadCurrentDocumentSnapshot.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DocumentWorkspace document={snapshot.summary} />);
    });

    const gap = container.querySelector(
      '[data-testid="empty-child-gap"]',
    ) as HTMLButtonElement | null;

    expect(gap).not.toBeNull();
    expect(gap?.style.minHeight).toBeTruthy();

    await act(async () => {
      gap?.click();
    });

    const nextSnapshot = useDocumentStore.getState().snapshot;
    const cardBChildren = nextSnapshot?.cards
      .filter((card) => card.parentId === "card-b")
      .sort((left, right) => left.orderIndex - right.orderIndex);

    expect(cardBChildren).toHaveLength(1);
    expect(useInteractionStore.getState().activeCardId).toBe(cardBChildren?.[0]?.id);
    expect(useAppStore.getState().mode).toBe("editing");

    await act(async () => {
      root.unmount();
    });
  });
});
