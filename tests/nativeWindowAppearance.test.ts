import { describe, expect, it } from "vitest";
import {
  consumeNativeWindowAppearanceTitleBarStyleSyncForProcess,
  readNativeWindowAppearanceDiagnosticMode,
  resetNativeWindowAppearanceTitleBarStyleSyncForTests,
  resolveNativeWindowAppearance,
} from "../src/lib/nativeWindowAppearance";

describe("resolveNativeWindowAppearance", () => {
  it("matches the light theme exactly to the card background", () => {
    expect(resolveNativeWindowAppearance("light")).toEqual({
      appTheme: "light",
      backgroundColor: [253, 246, 239],
      theme: "light",
      titleBarStyle: "overlay",
    });
  });

  it("matches the dark theme exactly to the card background", () => {
    expect(resolveNativeWindowAppearance("dark")).toEqual({
      appTheme: "dark",
      backgroundColor: [24, 25, 27],
      theme: "dark",
      titleBarStyle: "overlay",
    });
  });

  it("reads only supported native appearance diagnostic modes", () => {
    window.localStorage.setItem(
      "fablecraft.native-window-appearance-diagnostic",
      "set-window-theme",
    );

    expect(readNativeWindowAppearanceDiagnosticMode()).toBe("set-window-theme");

    window.localStorage.setItem(
      "fablecraft.native-window-appearance-diagnostic",
      "anything-else",
    );

    expect(readNativeWindowAppearanceDiagnosticMode()).toBeNull();
  });

  it("allows title bar style sync only once per app process", () => {
    resetNativeWindowAppearanceTitleBarStyleSyncForTests();

    expect(consumeNativeWindowAppearanceTitleBarStyleSyncForProcess(true)).toBe(true);
    expect(consumeNativeWindowAppearanceTitleBarStyleSyncForProcess(true)).toBe(false);

    resetNativeWindowAppearanceTitleBarStyleSyncForTests();

    expect(consumeNativeWindowAppearanceTitleBarStyleSyncForProcess(false)).toBe(false);
  });
});
