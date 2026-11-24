export const manuscriptCommands = [
  ["layout-tree", "Show Tree"],
  ["layout-both", "Show Both"],
  ["layout-manuscript", "Show Manuscript"],
  ["pane-left", "Focus Pane Left"],
  ["pane-right", "Focus Pane Right"],
  ["write-manuscript", "Write Manuscript"],
  ["remove-manuscript", "Remove Manuscript"],
  ["link-manuscript-passage", "Link Manuscript Passage"],
  ["import-manuscript-markdown", "Import Manuscript Markdown"],
  ["export-manuscript-markdown", "Export Manuscript Markdown"],
] as const;

export type ManuscriptCommand = (typeof manuscriptCommands)[number][0];
