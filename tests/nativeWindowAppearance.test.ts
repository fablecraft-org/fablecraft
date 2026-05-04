import { describe, expect, it } from "vitest";
import { resolveNativeWindowAppearance } from "../src/lib/nativeWindowAppearance";

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
});
