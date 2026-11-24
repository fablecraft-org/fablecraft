import { manuscriptLayoutTokens, writingLayoutTokens } from "../../styles/tokens";

export type WorkspacePane = "tree" | "manuscript";
export type WorkspaceLayout = WorkspacePane | "both";

const treeMinimum = writingLayoutTokens.minimumCardWidth + 2 * writingLayoutTokens.margin;
const proseMinimum = manuscriptLayoutTokens.proseMinimum + 2 * manuscriptLayoutTokens.panePadding;
const gap = manuscriptLayoutTokens.dividerWidth;

export const splitMinimumWidth = treeMinimum + proseMinimum + gap;

export function splitTreeWidth(width: number, ratio: number) {
  return Math.max(treeMinimum, Math.min(width - proseMinimum - gap, width * ratio));
}

export function stepWorkspace(layout: WorkspaceLayout, pane: WorkspacePane, direction: -1 | 1, fits: boolean): { layout: WorkspaceLayout; pane: WorkspacePane } {
  const destination = direction < 0 ? "tree" : "manuscript";
  const visible = layout === "both" && !fits ? pane : layout;
  if (visible === destination) return { layout, pane };
  if (!fits || (visible === "both" && pane === destination)) return { layout: destination, pane: destination };
  return { layout: "both" as const, pane: destination };
}

export function paneShortcut(event: KeyboardEvent, apple: boolean) {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey || !event.altKey
    || (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
}
