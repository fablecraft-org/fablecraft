import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TreeCardButton } from "../src/components/TreeCardButton";

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}

  disconnect() {}

  observe() {
    this.callback([], this as unknown as ResizeObserver);
  }

  takeRecords() {
    return [];
  }

  unobserve() {}
}

function mockRect(height: number): DOMRect {
  return {
    bottom: height,
    height,
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
}

function mockLayoutHeight(height: number) {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return height;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return height;
    },
  });
}

describe("TreeCardButton", () => {
  const originalActEnvironment = (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
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
  });

  it("measures the full rendered card surface and resets preview paragraph margins", () => {
    HTMLElement.prototype.getBoundingClientRect = () => mockRect(180);
    mockLayoutHeight(180);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const measuredHeights: number[] = [];

    act(() => {
      root.render(
        <TreeCardButton
          borderColor="#111111"
          cardLabel="B01"
          contentJson='{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}'
          isNeighborhood
          onClick={() => {}}
          onMeasureHeight={(height) => measuredHeights.push(height)}
          x={0}
          y={0}
        />,
      );
    });

    const paragraph = container.querySelector(".fc-preview p");

    expect(measuredHeights[0]).toBe(180);
    expect(paragraph?.className).toContain("m-0");
    expect(container.textContent).toContain("B01");

    act(() => {
      root.unmount();
    });
  });

  it("measures layout height instead of transformed bounding height", () => {
    HTMLElement.prototype.getBoundingClientRect = () => mockRect(148);
    mockLayoutHeight(180);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const measuredHeights: number[] = [];

    act(() => {
      root.render(
        <TreeCardButton
          borderColor="#111111"
          cardLabel="B01"
          contentJson='{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}'
          isNeighborhood
          onClick={() => {}}
          onMeasureHeight={(height) => measuredHeights.push(height)}
          scale={0.82}
          x={0}
          y={0}
        />,
      );
    });

    expect(measuredHeights[0]).toBe(180);

    act(() => {
      root.unmount();
    });
  });

  it("renders heading and bullet list structure in preview mode", () => {
    HTMLElement.prototype.getBoundingClientRect = () => mockRect(220);
    mockLayoutHeight(220);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TreeCardButton
          borderColor="#111111"
          cardLabel="B01"
          contentJson={JSON.stringify({
            content: [
              {
                attrs: { level: 2 },
                content: [{ text: "Heading", type: "text" }],
                type: "heading",
              },
              {
                content: [
                  {
                    content: [
                      {
                        content: [{ text: "First point", type: "text" }],
                        type: "paragraph",
                      },
                    ],
                    type: "listItem",
                  },
                ],
                type: "bulletList",
              },
            ],
            type: "doc",
          })}
          isNeighborhood
          onClick={() => {}}
          x={0}
          y={0}
        />,
      );
    });

    expect(container.querySelector("h2")?.textContent).toBe("Heading");
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("li")?.textContent).toContain("First point");

    act(() => {
      root.unmount();
    });
  });

  it("renders an empty preview placeholder without changing stored content", () => {
    HTMLElement.prototype.getBoundingClientRect = () => mockRect(84);
    mockLayoutHeight(84);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TreeCardButton
          borderColor="#111111"
          cardLabel="B01"
          contentJson='{"type":"doc","content":[{"type":"paragraph"}]}'
          isNeighborhood
          onClick={() => {}}
          placeholder="empty card"
          x={0}
          y={0}
        />,
      );
    });

    const paragraph = container.querySelector(".fc-preview p");

    expect(paragraph?.textContent).toBe("empty card");
    expect(paragraph?.className).toContain("italic");

    act(() => {
      root.unmount();
    });
  });

  it("renders only the first content line in overview cards", () => {
    HTMLElement.prototype.getBoundingClientRect = () => mockRect(56);
    mockLayoutHeight(56);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TreeCardButton
          borderColor="#111111"
          cardLabel="B01"
          cardWidth={236}
          contentJson='{"type":"doc","content":[{"type":"heading","content":[{"type":"text","text":"Scene title"}]},{"type":"paragraph","content":[{"type":"text","text":"Hidden body"}]}]}'
          isNeighborhood
          minHeight={72}
          onClick={() => {}}
          titleOnly
          x={0}
          y={0}
        />,
      );
    });

    expect(container.textContent).toContain("Scene title");
    expect(container.textContent).not.toContain("Hidden body");
    expect(container.querySelector(".fc-preview")).toBeNull();
    const titleParagraph = Array.from(container.querySelectorAll("p")).find(
      (paragraph) => paragraph.textContent === "Scene title",
    ) as HTMLParagraphElement | undefined;
    expect(titleParagraph?.className).toContain("overflow-hidden");
    expect(titleParagraph?.className).not.toContain("truncate");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the active border thin and softens neighborhood vs distant cards differently", () => {
    HTMLElement.prototype.getBoundingClientRect = () => mockRect(180);
    mockLayoutHeight(180);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <>
        <TreeCardButton
          borderColor="#111111"
          cardLabel="A01"
          contentJson='{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Active"}]}]}'
          isActive
            isNeighborhood
            onClick={() => {}}
            x={0}
            y={0}
          />
          <TreeCardButton
            borderColor="#111111"
            cardLabel="B01"
            contentJson='{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Nearby"}]}]}'
            isNeighborhood
            onClick={() => {}}
            x={0}
            y={0}
          />
          <TreeCardButton
            borderColor="#111111"
            cardLabel="B02"
            contentJson='{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Far"}]}]}'
            isNeighborhood={false}
            onClick={() => {}}
            x={0}
            y={0}
          />
        </>,
      );
    });

    const cards = container.querySelectorAll("div.absolute");
    const activeCard = cards[0] as HTMLDivElement | undefined;
    const neighborhoodCard = cards[1] as HTMLDivElement | undefined;
    const distantCard = cards[2] as HTMLDivElement | undefined;

    expect(activeCard?.style.borderWidth).toBe("0px");
    expect(activeCard?.style.opacity).toBe("1");
    expect(activeCard?.style.paddingTop).toBe("40px");
    expect(activeCard?.querySelector("p")?.className).toContain(
      "text-[var(--fc-color-card-label)]",
    );
    expect(neighborhoodCard?.style.borderWidth).toBe("0px");
    expect(neighborhoodCard?.style.opacity).toBe("1");
    expect(neighborhoodCard?.style.boxShadow).toBeTruthy();
    expect(distantCard?.style.borderWidth).toBe("0px");
    expect(distantCard?.style.opacity).toBe("1");
    expect(distantCard?.style.boxShadow).toBe("none");

    act(() => {
      root.unmount();
    });
  });

});
