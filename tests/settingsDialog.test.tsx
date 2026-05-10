import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../src/components/SettingsDialog";
import { useSettingsStore } from "../src/state/settingsStore";

describe("SettingsDialog", () => {
  const originalActEnvironment = (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useSettingsStore.getState().resetPreferences();
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    document.body.innerHTML = "";
    useSettingsStore.getState().resetPreferences();
  });

  it("uses row-based inline controls instead of native selectors", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<SettingsDialog onClose={() => {}} />);
    });

    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll('section[data-testid^="setting-row-"]')).toHaveLength(
      6,
    );
    expect(container.textContent).toContain("Text Size");
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain("Dark");
    expect(
      container.querySelector('[data-testid="setting-row-theme"]')?.textContent,
    ).toContain("Light");
    expect(container.querySelector('[data-testid="overlay-panel"]')?.className).toContain(
      "max-h-[calc(100vh-2rem)]",
    );
    expect(container.querySelector('[data-testid="overlay-content"]')?.className).toContain(
      "overflow-y-auto",
    );

    act(() => {
      root.unmount();
    });
  });

  it("focuses the first settings row when the dialog opens", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<SettingsDialog onClose={() => {}} />);
    });

    const themeRow = container.querySelector(
      '[data-testid="setting-row-theme"]',
    ) as HTMLDivElement | null;

    expect(document.activeElement).toBe(themeRow);

    act(() => {
      root.unmount();
    });
  });

  it("uses up/down to move rows and left/right to change the current row", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<SettingsDialog onClose={() => {}} />);
    });

    const themeRow = container.querySelector(
      '[data-testid="setting-row-theme"]',
    ) as HTMLDivElement | null;
    const fontRow = container.querySelector(
      '[data-testid="setting-row-font"]',
    ) as HTMLDivElement | null;
    const themeChevron = container.querySelector(
      '[data-testid="setting-row-theme-chevron"]',
    ) as HTMLElement | null;

    expect(themeRow).toBeDefined();
    expect(fontRow).toBeDefined();
    expect(useSettingsStore.getState().preferences.theme).toBe("light");
    expect(themeChevron?.style.opacity).toBe("1");

    act(() => {
      themeRow?.focus();
      themeRow?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(useSettingsStore.getState().preferences.theme).toBe("dark");
    expect(themeRow?.textContent).toContain("Dark");
    expect(themeRow?.dataset.active).toBe("true");
    expect(themeChevron?.style.opacity).toBe("1");
    expect(document.activeElement).toBe(themeRow);

    act(() => {
      themeRow?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    expect(document.activeElement).toBe(fontRow);
    expect(themeRow?.dataset.active).toBe("false");

    act(() => {
      root.unmount();
    });
  });

  it("keeps keyboard focus after changing theme with a click", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();

    act(() => {
      root.render(<SettingsDialog onClose={onClose} />);
    });

    const themeRow = container.querySelector(
      '[data-testid="setting-row-theme"]',
    ) as HTMLDivElement | null;
    const fontRow = container.querySelector(
      '[data-testid="setting-row-font"]',
    ) as HTMLDivElement | null;
    const themeChevron = container.querySelector(
      '[data-testid="setting-row-theme-chevron"]',
    ) as HTMLElement | null;
    const darkButton = Array.from(themeRow?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.includes("Dark"),
    ) as HTMLButtonElement | undefined;

    act(() => {
      darkButton?.click();
    });

    expect(useSettingsStore.getState().preferences.theme).toBe("dark");
    expect(document.activeElement).toBe(themeRow);
    expect(themeRow?.dataset.active).toBe("true");
    expect(themeChevron?.style.opacity).toBe("1");

    act(() => {
      themeRow?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    expect(document.activeElement).toBe(fontRow);

    act(() => {
      fontRow?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("keeps settings keyboard controls alive when theme changes leave row focus", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const externalFocusTarget = document.createElement("button");
    document.body.appendChild(externalFocusTarget);
    const root = createRoot(container);
    const onClose = vi.fn();

    act(() => {
      root.render(<SettingsDialog onClose={onClose} />);
    });

    const themeRow = container.querySelector(
      '[data-testid="setting-row-theme"]',
    ) as HTMLDivElement | null;
    const fontRow = container.querySelector(
      '[data-testid="setting-row-font"]',
    ) as HTMLDivElement | null;
    const themeChevron = container.querySelector(
      '[data-testid="setting-row-theme-chevron"]',
    ) as HTMLElement | null;
    const darkButton = Array.from(themeRow?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.includes("Dark"),
    ) as HTMLButtonElement | undefined;
    act(() => {
      darkButton?.click();
    });

    act(() => {
      externalFocusTarget.focus();
    });

    expect(useSettingsStore.getState().preferences.theme).toBe("dark");
    expect(themeRow?.dataset.active).toBe("true");
    expect(themeChevron?.style.opacity).toBe("1");
    expect(document.activeElement).toBe(externalFocusTarget);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    expect(document.activeElement).toBe(fontRow);

    act(() => {
      externalFocusTarget.focus();
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
