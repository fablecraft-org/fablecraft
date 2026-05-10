import { setTheme as setAppTheme } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, type Color, type TitleBarStyle } from "@tauri-apps/api/window";
import { themeAppColor, type UiTheme } from "../styles/tokens";

interface NativeWindowAppearance {
  appTheme: UiTheme;
  backgroundColor: Color;
  theme: UiTheme;
  titleBarStyle: TitleBarStyle;
}

interface SyncNativeWindowAppearanceOptions {
  restoreFocus?: boolean;
}

type NativeWindowAppearanceDiagnosticMode =
  | "all"
  | "no-native"
  | "set-app-theme"
  | "set-background-color"
  | "set-window-theme"
  | "set-title-bar-style";

const MAC_TITLE_BAR_STYLE: TitleBarStyle = "overlay";
const DIAGNOSTIC_STORAGE_KEY = "fablecraft.native-window-appearance-diagnostic";
let titleBarStyleSyncedForProcess = false;

export function resolveNativeWindowAppearance(theme: UiTheme): NativeWindowAppearance {
  return {
    appTheme: theme,
    backgroundColor: hexColorToRgb(themeAppColor(theme)),
    theme,
    titleBarStyle: MAC_TITLE_BAR_STYLE,
  };
}

export async function syncNativeWindowAppearance(
  theme: UiTheme,
  options: SyncNativeWindowAppearanceOptions = {},
) {
  if (!isTauri()) {
    return;
  }

  const appearance = resolveNativeWindowAppearance(theme);
  const currentWindow = getCurrentWindow();
  const diagnosticMode = readNativeWindowAppearanceDiagnosticMode();

  if (diagnosticMode) {
    await syncNativeWindowAppearanceDiagnostic(diagnosticMode, appearance, currentWindow);
    return;
  }

  const operations: Array<Promise<void>> = [
    setAppTheme(appearance.appTheme),
    currentWindow.setBackgroundColor(appearance.backgroundColor),
    currentWindow.setTheme(appearance.theme),
  ];

  if (consumeNativeWindowAppearanceTitleBarStyleSyncForProcess()) {
    operations.push(currentWindow.setTitleBarStyle(appearance.titleBarStyle));
  }

  const results = await Promise.allSettled(operations);

  results.forEach((result) => {
    if (result.status === "rejected") {
      console.warn("Fablecraft could not sync the native window appearance.", result.reason);
    }
  });

  if (options.restoreFocus) {
    await restoreNativeFocusAfterAppearanceSync(currentWindow);
  }
}

async function restoreNativeFocusAfterAppearanceSync(
  currentWindow: ReturnType<typeof getCurrentWindow>,
) {
  const focusWebview = async () => {
    await getCurrentWebview().setFocus();
  };

  const focusResults = await Promise.allSettled([
    currentWindow.setFocus(),
    focusWebview(),
  ]);

  focusResults.forEach((result) => {
    if (result.status === "rejected") {
      console.warn("Fablecraft could not restore focus after theme sync.", result.reason);
    }
  });

  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const delayedFocusResults = await Promise.allSettled([
    currentWindow.setFocus(),
    focusWebview(),
  ]);

  delayedFocusResults.forEach((result) => {
    if (result.status === "rejected") {
      console.warn(
        "Fablecraft could not restore delayed focus after theme sync.",
        result.reason,
      );
    }
  });
}

export function consumeNativeWindowAppearanceTitleBarStyleSyncForProcess(
  platformIsMac = isMacOs(),
) {
  if (!platformIsMac || titleBarStyleSyncedForProcess) {
    return false;
  }

  titleBarStyleSyncedForProcess = true;
  return true;
}

export function resetNativeWindowAppearanceTitleBarStyleSyncForTests() {
  titleBarStyleSyncedForProcess = false;
}

export function readNativeWindowAppearanceDiagnosticMode():
  | NativeWindowAppearanceDiagnosticMode
  | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedValue = window.localStorage.getItem(DIAGNOSTIC_STORAGE_KEY);
  const modes: NativeWindowAppearanceDiagnosticMode[] = [
    "all",
    "no-native",
    "set-app-theme",
    "set-background-color",
    "set-window-theme",
    "set-title-bar-style",
  ];

  return modes.includes(storedValue as NativeWindowAppearanceDiagnosticMode)
    ? (storedValue as NativeWindowAppearanceDiagnosticMode)
    : null;
}

async function syncNativeWindowAppearanceDiagnostic(
  mode: NativeWindowAppearanceDiagnosticMode,
  appearance: NativeWindowAppearance,
  currentWindow: ReturnType<typeof getCurrentWindow>,
) {
  console.info(`[theme-focus] diagnostic mode: ${mode}`);

  if (mode === "no-native") {
    await logNativeFocusState("no-native");
    return;
  }

  const operations: Array<{
    label: NativeWindowAppearanceDiagnosticMode;
    run: () => Promise<void>;
  }> = [
    {
      label: "set-app-theme",
      run: () => setAppTheme(appearance.appTheme),
    },
    {
      label: "set-background-color",
      run: () => currentWindow.setBackgroundColor(appearance.backgroundColor),
    },
    {
      label: "set-window-theme",
      run: () => currentWindow.setTheme(appearance.theme),
    },
  ];

  if (isMacOs()) {
    operations.push({
      label: "set-title-bar-style",
      run: () => currentWindow.setTitleBarStyle(appearance.titleBarStyle),
    });
  }

  for (const operation of operations) {
    if (mode !== "all" && mode !== operation.label) {
      continue;
    }

    await traceNativeAppearanceOperation(operation.label, operation.run, currentWindow);
  }
}

async function traceNativeAppearanceOperation(
  label: string,
  operation: () => Promise<void>,
  currentWindow: ReturnType<typeof getCurrentWindow>,
) {
  await logNativeFocusState(`before ${label}`, currentWindow);

  try {
    await operation();
  } catch (error) {
    console.warn(`[theme-focus] ${label} failed`, error);
  }

  await logNativeFocusState(`after ${label}`, currentWindow);
  await new Promise((resolve) => window.setTimeout(resolve, 75));
  await logNativeFocusState(`after ${label} +75ms`, currentWindow);
}

async function logNativeFocusState(
  label: string,
  currentWindow: ReturnType<typeof getCurrentWindow> = getCurrentWindow(),
) {
  let nativeWindowFocused: boolean | "unknown" = "unknown";

  try {
    nativeWindowFocused = await currentWindow.isFocused();
  } catch {
    nativeWindowFocused = "unknown";
  }

  console.info(`[theme-focus] ${label}`, {
    activeElement: document.activeElement
      ? `${document.activeElement.tagName.toLowerCase()}${
          document.activeElement.getAttribute("data-testid")
            ? `[data-testid="${document.activeElement.getAttribute("data-testid")}"]`
            : ""
        }`
      : null,
    documentHasFocus: document.hasFocus(),
    nativeWindowFocused,
    visibilityState: document.visibilityState,
  });
}

function hexColorToRgb(hexColor: string): [number, number, number] {
  const normalizedValue = hexColor.trim().replace("#", "");

  if (!/^[0-9a-fA-F]{6}$/.test(normalizedValue)) {
    throw new Error(`Unsupported theme color: ${hexColor}`);
  }

  return [
    Number.parseInt(normalizedValue.slice(0, 2), 16),
    Number.parseInt(normalizedValue.slice(2, 4), 16),
    Number.parseInt(normalizedValue.slice(4, 6), 16),
  ];
}

function isMacOs() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);
}
