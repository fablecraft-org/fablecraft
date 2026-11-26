export type UiTheme = "light" | "dark";
export type UiFont = "serif" | "sans";
export type UiTextSize = "comfortable" | "large";
export type UiLineHeight = "compact" | "relaxed";
export type UiNeighborCards = "visible" | "hidden";
export type UiScrollPan = "enabled" | "disabled";

export interface UiPreferences {
  font: UiFont;
  lineHeight: UiLineHeight;
  neighborCards: UiNeighborCards;
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
    passageHighlight: "#e1dcd6",
    passageHighlightActive: "#ffe34d",
    passageHighlightText: "#171412",
    explorerDocumentSurface: "#fffaf6",
    explorerFolderSurface: "#efe4da",
    cardSurface: "#fdf6ef",
    cardSurfaceActive: "#fdf6ef",
    cardSurfaceEditing: "#fdf6ef",
    focus: "#24262a",
    historyAdded: "#286443",
    historyAddedSurface: "#e1f2e5",
    historyModified: "#8f4b17",
    historyModifiedSurface: "#faead9",
    historyRemoved: "#a33a43",
    historyRemovedSurface: "#fbe6e7",
    muted: "#756c64",
    noticeBorder: "rgba(245, 238, 229, 0.18)",
    noticeSurface: "#18191b",
    noticeText: "#f4f4f1",
    onDark: "#fff7f1",
    overlayBackdrop: "rgba(245, 236, 230, 0.82)",
    overviewCardShadow: "0 12px 28px rgba(23, 20, 18, 0.08)",
    overviewCardShadowActive: "0 12px 28px rgba(23, 20, 18, 0.18)",
    overviewConnector: "#e1dbd6",
    overviewConnectorActive: "#b2aaa3",
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
    passageHighlight: "#484b50",
    passageHighlightActive: "#ffe34d",
    passageHighlightText: "#171412",
    explorerDocumentSurface: "#2d3035",
    explorerFolderSurface: "#202226",
    cardSurface: "#24262a",
    cardSurfaceActive: "#2d3035",
    cardSurfaceEditing: "#373b41",
    focus: "#f4f4f1",
    historyAdded: "#8fdaa9",
    historyAddedSurface: "#233b30",
    historyModified: "#ffc28d",
    historyModifiedSurface: "#453225",
    historyRemoved: "#ff9ca7",
    historyRemovedSurface: "#4d292e",
    muted: "#b7bbc1",
    noticeBorder: "rgba(24, 25, 27, 0.14)",
    noticeSurface: "#2d3035",
    noticeText: "#f4f4f1",
    onDark: "#18191b",
    overlayBackdrop: "rgba(12, 13, 15, 0.72)",
    overviewCardShadow: "0 12px 28px rgba(0, 0, 0, 0.24)",
    overviewCardShadowActive: "0 12px 28px rgba(0, 0, 0, 0.48)",
    overviewConnector: "#5c6066",
    overviewConnectorActive: "#464a51",
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
  passageHighlight: string;
  passageHighlightActive: string;
  passageHighlightText: string;
  explorerDocumentSurface: string;
  explorerFolderSurface: string;
  cardSurface: string;
  cardSurfaceActive: string;
  cardSurfaceEditing: string;
  focus: string;
  historyAdded: string;
  historyAddedSurface: string;
  historyModified: string;
  historyModifiedSurface: string;
  historyRemoved: string;
  historyRemovedSurface: string;
  muted: string;
  noticeBorder: string;
  noticeSurface: string;
  noticeText: string;
  onDark: string;
  overlayBackdrop: string;
  overviewCardShadow: string;
  overviewCardShadowActive: string;
  overviewConnector: string;
  overviewConnectorActive: string;
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

export const writingLayoutTokens = {
  minimumCardWidth: 360,
  maximumColumns: 4,
  margin: 24,
  spacing: 24,
  verticalInset: 48,
};

export const writingZoomLevels = ["compact", "normal", "large"] as const;
export type WritingZoom = (typeof writingZoomLevels)[number];

export const writingZoomTokens = {
  compact: { scale: 0.85, minimumCardWidth: 272, maximumCardWidth: 352, manuscriptWidth: 612 },
  normal: { scale: 1, manuscriptWidth: 720 },
  large: { scale: 1.25, maximumColumns: 1, maximumCardWidth: 880, manuscriptWidth: 900 },
};

export function writingTypography(preferences: UiPreferences, zoom: WritingZoom) {
  const { scale } = writingZoomTokens[zoom];
  return {
    size: `${parseFloat(textSizeTokens[preferences.textSize]) * scale}rem`,
    lineHeight: `${parseFloat(lineHeightTokens[preferences.lineHeight]) * scale}rem`,
  };
}

const defaultUiPreferences: UiPreferences = {
  font: "sans",
  lineHeight: "compact",
  neighborCards: "visible",
  scrollPan: "enabled",
  textSize: "comfortable",
  theme: "light",
};

const uiTokens = {
  animationEasing: "cubic-bezier(0.2, 0.85, 0.3, 1)",
  animationMs: 140,
  cardNavigationMs: 150,
  cardHeight: 84,
  directoryCardWidth: 468,
  cardLink: { fontSize: "0.75em", paddingX: 5, paddingY: 1, gap: 2 },
  referenceIconSize: 14,
  cardIdentity: {
    badgeWidth: 26,
    badgeHeight: 18,
    badgeRadius: 3,
    gap: 8,
    inset: 28,
    top: 18,
    compactInset: 18,
    compactTop: 12,
    titleReserve: 88,
  },
  documentTitle: {
    controlsInset: 80,
    fade: 32,
    fontSize: 13,
    fontWeight: 500,
    height: 32,
    maxWidth: 520,
    padding: 16,
  },
  windowDragHeight: 128,
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
    font: normalizeEnumValue(value?.font, ["serif", "sans"], defaultUiPreferences.font),
    lineHeight: normalizeEnumValue(
      value?.lineHeight,
      ["compact", "relaxed"],
      defaultUiPreferences.lineHeight,
    ),
    neighborCards: normalizeEnumValue(
      value?.neighborCards,
      ["visible", "hidden"],
      defaultUiPreferences.neighborCards,
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

export function resolveUiMetrics(_preferences: UiPreferences) {
  return {
    cardHeight: uiTokens.cardHeight,
    cardWidth: uiTokens.directoryCardWidth,
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
    "--fc-reference-icon-size": `${uiTokens.referenceIconSize}px`,
    "--fc-card-identity-inset": `${uiTokens.cardIdentity.inset}px`,
    "--fc-card-identity-top": `${uiTokens.cardIdentity.top}px`,
    "--fc-card-identity-compact-inset": `${uiTokens.cardIdentity.compactInset}px`,
    "--fc-card-identity-compact-top": `${uiTokens.cardIdentity.compactTop}px`,
    "--fc-card-identity-gap": `${uiTokens.cardIdentity.gap}px`,
    "--fc-card-link-font-size": uiTokens.cardLink.fontSize,
    "--fc-card-link-padding-x": `${uiTokens.cardLink.paddingX}px`,
    "--fc-card-link-padding-y": `${uiTokens.cardLink.paddingY}px`,
    "--fc-card-link-gap": `${uiTokens.cardLink.gap}px`,
    "--fc-descendant-badge-width": `${uiTokens.cardIdentity.badgeWidth}px`,
    "--fc-descendant-badge-height": `${uiTokens.cardIdentity.badgeHeight}px`,
    "--fc-descendant-badge-radius": `${uiTokens.cardIdentity.badgeRadius}px`,
    "--fc-card-identity-title-reserve": `${uiTokens.cardIdentity.titleReserve}px`,
    "--fc-color-app": theme.app,
    "--fc-color-border": theme.border,
    "--fc-color-border-strong": theme.borderStrong,
    "--fc-color-card-label": theme.cardLabel,
    "--fc-color-passage-highlight": theme.passageHighlight,
    "--fc-color-passage-highlight-active": theme.passageHighlightActive,
    "--fc-color-passage-highlight-text": theme.passageHighlightText,
    "--fc-color-explorer-document-surface": theme.explorerDocumentSurface,
    "--fc-color-explorer-folder-surface": theme.explorerFolderSurface,
    "--fc-color-card-surface": theme.cardSurface,
    "--fc-color-card-surface-active": theme.cardSurfaceActive,
    "--fc-color-card-surface-editing": theme.cardSurfaceEditing,
    "--fc-color-focus": theme.focus,
    "--fc-color-history-added": theme.historyAdded,
    "--fc-color-history-added-surface": theme.historyAddedSurface,
    "--fc-color-history-modified": theme.historyModified,
    "--fc-color-history-modified-surface": theme.historyModifiedSurface,
    "--fc-color-history-removed": theme.historyRemoved,
    "--fc-color-history-removed-surface": theme.historyRemovedSurface,
    "--fc-color-muted": theme.muted,
    "--fc-color-notice-border": theme.noticeBorder,
    "--fc-color-notice-surface": theme.noticeSurface,
    "--fc-color-notice-text": theme.noticeText,
    "--fc-color-on-dark": theme.onDark,
    "--fc-color-overlay-backdrop": theme.overlayBackdrop,
    "--fc-shadow-overview-card": theme.overviewCardShadow,
    "--fc-shadow-overview-card-active": theme.overviewCardShadowActive,
    "--fc-color-overview-connector": theme.overviewConnector,
    "--fc-color-overview-connector-active": theme.overviewConnectorActive,
    "--fc-color-surface": theme.surface,
    "--fc-color-surface-strong": theme.surfaceStrong,
    "--fc-color-text": theme.text,
    "--fc-content-line-height": lineHeightTokens[preferences.lineHeight],
    "--fc-content-size": textSizeTokens[preferences.textSize],
    "--fc-font-content": fonts.content,
    "--fc-font-ui": fonts.ui,
    "--fc-document-title-controls-inset": `${uiTokens.documentTitle.controlsInset}px`,
    "--fc-document-title-fade": `${uiTokens.documentTitle.fade}px`,
    "--fc-document-title-font-size": `${uiTokens.documentTitle.fontSize}px`,
    "--fc-document-title-font-weight": `${uiTokens.documentTitle.fontWeight}`,
    "--fc-document-title-height": `${uiTokens.documentTitle.height}px`,
    "--fc-document-title-max-width": `${uiTokens.documentTitle.maxWidth}px`,
    "--fc-document-title-padding": `${uiTokens.documentTitle.padding}px`,
    "--fc-window-drag-height": `${uiTokens.windowDragHeight}px`,
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

export const manuscriptLayoutTokens = {
  proseMinimum: 360,
  controlGap: 8,
  linkBarWidth: 4,
  panePadding: 32,
  touchPanePadding: 24,
  topInset: 54,
  dividerWidth: 9,
  initialTreeRatio: 0.4,
  dividerKeyboardStep: 24,
};

export const historyLayoutTokens = {
  timelineWidth: 252,
  narrowWidth: 800,
  gap: 12,
  padding: 16,
} as const;
