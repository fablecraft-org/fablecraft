import { invoke } from "@tauri-apps/api/core";
import type { ManuscriptCommand } from "../components/manuscriptCommands";

export const NATIVE_MENU_ACTION_EVENT = "fablecraft://menu-action";
export const FRONTEND_MENU_ACTION_EVENT = "fablecraft:menu-action";

export type NativeMenuAction =
  | ManuscriptCommand
  | "check-for-updates"
  | "command-palette"
  | "create-above"
  | "create-below"
  | "create-child"
  | "create-anchored-child"
  | "create-parent"
  | "enable-claude-desktop"
  | "enable-codex"
  | "export-markdown"
  | "help-getting-started"
  | "help-commands"
  | "help-report-bug"
  | "help-request-feature"
  | "help-shortcuts"
  | "import-markdown"
  | "merge-below"
  | "merge-with-above"
  | "new-document"
  | "open-document"
  | "open-recent"
  | "restore-manuscript-focus"
  | "reload-window"
  | "redo"
  | "save"
  | "search"
  | "show-history"
  | "settings"
  | "shift-down"
  | "shift-up"
  | "split"
  | "undo"
  | "view-wide-lens"
  | "view-normal"
  | "view-compact"
  | "view-large"
  | "zoom-in"
  | "zoom-out";

interface NativeMenuActionPayload {
  action: NativeMenuAction;
}

export function dispatchNativeMenuAction(action: NativeMenuAction) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<NativeMenuActionPayload>(FRONTEND_MENU_ACTION_EVENT, {
      detail: { action },
    }),
  );
}

export function listenForFrontendMenuActions(
  onAction: (action: NativeMenuAction) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  function handleMenuAction(event: Event) {
    const payload = (event as CustomEvent<NativeMenuActionPayload>).detail;

    if (!payload) {
      return;
    }

    onAction(payload.action);
  }

  window.addEventListener(FRONTEND_MENU_ACTION_EVENT, handleMenuAction);

  return () => {
    window.removeEventListener(FRONTEND_MENU_ACTION_EVENT, handleMenuAction);
  };
}

export async function listenForNativeMenuActions(
  onAction: (action: NativeMenuAction) => void,
) {
  try {
    const { listen } = await import("@tauri-apps/api/event");

    return await listen<NativeMenuActionPayload>(
      NATIVE_MENU_ACTION_EVENT,
      (event) => {
        onAction(event.payload.action);
      },
    );
  } catch {
    return () => {};
  }
}


export interface WorkspaceMenuState {
  documentOpen: boolean;
  manuscript: boolean;
  treeActive: boolean;
  splitFits: boolean;
  link: boolean;
  dialog: boolean;
}

export function updateWorkspaceMenu(state: WorkspaceMenuState) {
  return invoke("update_workspace_menu", { state });
}
