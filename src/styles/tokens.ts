export type UiTheme = "light" | "dark";
export type UiFont = "serif" | "sans";
export type UiTextSize = "comfortable" | "large";
export type UiLineHeight = "compact" | "relaxed";
export type UiCardWidth = "standard" | "wide";
export type UiScrollPan = "enabled" | "disabled";

export interface UiPreferences {
  cardWidth: UiCardWidth;
  font: UiFont;
  lineHeight: UiLineHeight;
  scrollPan: UiScrollPan;
  textSize: UiTextSize;
  theme: UiTheme;
}

const themeTokens = {
  light: {
    app: "#fdf6ef",
    border: "#a2978b",
    borderStrong: "#171412",
    cardLabel: "rgba(23, 20, 18, 0.34)",
    cardSurface: "#fdf6ef",
    cardSurfaceActive: "#fdf6ef",
    cardSurfaceEditing: "#fdf6ef",
    focus: "#24262a",
    muted: "#756c64",
    noticeBorder: "rgba(245, 238, 229, 0.18)",
    noticeSurface: "#18191b",
    noticeText: "#f4f4f1",
    onDark: "#fff7f1",
    overlayBackdrop: "rgba(245, 236, 230, 0.82)",
    shadowCard: "0 12px 28px rgba(23, 20, 18, 0.08)",
    shadowElevated: "0 18px 40px rgba(23, 20, 18, 0.14)",
    shadowSoft: "0 8px 18px rgba(23, 20, 18, 0.08)",
    surface: "#fdf6ef",
    surfaceStrong: "#fffaf6",
    text: "#171412",
  },
  dark: {
    app: "#18191b",
    border: "#6f7379",
    borderStrong: "#f4f4f1",
    cardLabel: "rgba(244, 244, 241, 0.68)",
    cardSurface: "#24262a",
    cardSurfaceActive: "#2d3035",
    cardSurfaceEditing: "#373b41",
    focus: "#f4f4f1",
    muted: "#b7bbc1",
    noticeBorder: "rgba(24, 25, 27, 0.14)",
    noticeSurface: "#2d3035",
    noticeText: "#f4f4f1",
    onDark: "#18191b",
    overlayBackdrop: "rgba(12, 13, 15, 0.72)",
    shadowCard: "none",
    shadowElevated: "none",
    shadowSoft: "none",
    surface: "#18191b",
    surfaceStrong: "#24262a",
    text: "#f4f4f1",
  },
} satisfies Record<UiTheme, {
  app: string;
  border: string;
  borderStrong: string;
  cardLabel: string;
  cardSurface: string;
  cardSurfaceActive: string;
  cardSurfaceEditing: string;
  focus: string;
  muted: string;
  noticeBorder: string;
  noticeSurface: string;
  noticeText: string;
  onDark: string;
  overlayBackdrop: string;
  shadowCard: string;
  shadowElevated: string;
  shadowSoft: string;
  surface: string;
  surfaceStrong: string;
  text: string;
}>;

export function themeSurfaceColor(theme: UiTheme) {
  return themeTokens[theme].surface;
}

export function themeAppColor(theme: UiTheme) {
  return themeTokens[theme].app;
}

const fontTokens = {
  sans: {
    content: "\"Avenir Next\", \"Segoe UI\", sans-serif",
    ui: "\"Avenir Next\", \"Segoe UI\", sans-serif",
  },
  serif: {
    content: "\"Iowan Old Style\", \"Palatino Linotype\", \"Book Antiqua\", Georgia, serif",
    ui: "\"Avenir Next\", \"Segoe UI\", sans-serif",
  },
} satisfies Record<UiFont, { content: string; ui: string }>;

const textSizeTokens = {
  comfortable: "0.95rem",
  large: "1.05rem",
} satisfies Record<UiTextSize, string>;

const lineHeightTokens = {
  compact: "1.75rem",
  relaxed: "2rem",
} satisfies Record<UiLineHeight, string>;

const cardWidthTokens = {
  standard: 468,
  wide: 500,
} satisfies Record<UiCardWidth, number>;

const defaultUiPreferences: UiPreferences = {
  cardWidth: "standard",
  font: "sans",
  lineHeight: "compact",
  scrollPan: "enabled",
  textSize: "comfortable",
  theme: "light",
};

const uiTokens = {
  animationEasing: "cubic-bezier(0.2, 0.85, 0.3, 1)",
  animationMs: 140,
  cardHeight: 84,
  radius: {
    card: 6,
    pill: 999,
  },
  spacing: 24,
};

type CssVariableMap = Record<string, string>;

function normalizeEnumValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowedValues.includes(value as T)
    ? (value as T)
    : fallback;
}

export function normalizeUiPreferences(
  value: Partial<UiPreferences> | null | undefined,
): UiPreferences {
  const rawThemeValue =
    value &&
    typeof (value as Record<string, unknown>).theme === "string"
      ? ((value as Record<string, unknown>).theme as string)
      : undefined;
  const normalizedThemeValue =
    rawThemeValue === "paper" || rawThemeValue === "studio" ? "light" : rawThemeValue;

  return {
    cardWidth: normalizeEnumValue(
      value?.cardWidth,
      ["standard", "wide"],
      defaultUiPreferences.cardWidth,
    ),
    font: normalizeEnumValue(value?.font, ["serif", "sans"], defaultUiPreferences.font),
    lineHeight: normalizeEnumValue(
      value?.lineHeight,
      ["compact", "relaxed"],
      defaultUiPreferences.lineHeight,
    ),
    scrollPan: normalizeEnumValue(
      value?.scrollPan,
      ["enabled", "disabled"],
      defaultUiPreferences.scrollPan,
    ),
    textSize: normalizeEnumValue(
      value?.textSize,
      ["comfortable", "large"],
      defaultUiPreferences.textSize,
    ),
    theme: normalizeEnumValue(normalizedThemeValue, ["light", "dark"], defaultUiPreferences.theme),
  };
}

export function resolveUiMetrics(preferences: UiPreferences) {
  return {
    cardHeight: uiTokens.cardHeight,
    cardWidth: cardWidthTokens[preferences.cardWidth],
    spacing: uiTokens.spacing,
  };
}

function buildCssVariables(preferences: UiPreferences): CssVariableMap {
  const theme = themeTokens[preferences.theme];
  const fonts = fontTokens[preferences.font];
  const metrics = resolveUiMetrics(preferences);

  return {
    "--fc-animation-easing": uiTokens.animationEasing,
    "--fc-animation-ms": `${uiTokens.animationMs}ms`,
    "--fc-card-height": `${metrics.cardHeight}px`,
    "--fc-card-width": `${metrics.cardWidth}px`,
    "--fc-color-app": theme.app,
    "--fc-color-border": theme.border,
    "--fc-color-border-strong": theme.borderStrong,
    "--fc-color-card-label": theme.cardLabel,
    "--fc-color-card-surface": theme.cardSurface,
    "--fc-color-card-surface-active": theme.cardSurfaceActive,
    "--fc-color-card-surface-editing": theme.cardSurfaceEditing,
    "--fc-color-focus": theme.focus,
    "--fc-color-muted": theme.muted,
    "--fc-color-notice-border": theme.noticeBorder,
    "--fc-color-notice-surface": theme.noticeSurface,
    "--fc-color-notice-text": theme.noticeText,
    "--fc-color-on-dark": theme.onDark,
    "--fc-color-overlay-backdrop": theme.overlayBackdrop,
    "--fc-color-surface": theme.surface,
    "--fc-color-surface-strong": theme.surfaceStrong,
    "--fc-color-text": theme.text,
    "--fc-content-line-height": lineHeightTokens[preferences.lineHeight],
    "--fc-content-size": textSizeTokens[preferences.textSize],
    "--fc-font-content": fonts.content,
    "--fc-font-ui": fonts.ui,
    "--fc-radius-card": `${uiTokens.radius.card}px`,
    "--fc-radius-pill": `${uiTokens.radius.pill}px`,
    "--fc-shadow-card": theme.shadowCard,
    "--fc-shadow-elevated": theme.shadowElevated,
    "--fc-shadow-soft": theme.shadowSoft,
    "--fc-spacing": `${uiTokens.spacing}px`,
  };
}

export function applyUiTokens(preferences: UiPreferences = defaultUiPreferences) {
  const root = document.documentElement;

  Object.entries(buildCssVariables(preferences)).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

export { defaultUiPreferences, uiTokens };
