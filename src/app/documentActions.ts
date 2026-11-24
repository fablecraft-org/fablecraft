import { open, save } from "@tauri-apps/plugin-dialog";
import { createDocumentAtPath, openDocumentAtPath } from "../storage/documents";
import {
  ensureFableExtension,
  ensureHtmlExtension,
  ensureMarkdownExtension,
  fileStem,
} from "../storage/filePaths";

const DOCUMENT_FILTERS = [{ name: "Fablecraft documents", extensions: ["fable"] }];
const MARKDOWN_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }];

async function promptToCreateDocument(title: string, defaultPath: string) {
  const selectedPath = await save({
    title,
    filters: DOCUMENT_FILTERS,
    defaultPath,
  });

  if (!selectedPath) {
    return null;
  }

  return createDocumentAtPath(ensureFableExtension(selectedPath));
}

export function promptForNewDocument() {
  return promptToCreateDocument("Create Fablecraft document", "untitled.fable");
}

export function promptForNewDocumentFromTree(defaultPath: string) {
  return promptToCreateDocument("New Document From Tree", defaultPath);
}

export async function promptForOpenDocument() {
  const selectedPath = await open({
    title: "Open Fablecraft document",
    directory: false,
    multiple: false,
    filters: DOCUMENT_FILTERS,
  });

  if (!selectedPath || Array.isArray(selectedPath)) {
    return null;
  }

  return openDocumentAtPath(selectedPath);
}

export async function promptForMarkdownImportPath(title = "Select Markdown file") {
  const selectedPath = await open({
    title,
    directory: false,
    multiple: false,
    filters: MARKDOWN_FILTERS,
  });

  if (!selectedPath || Array.isArray(selectedPath)) {
    return null;
  }

  return selectedPath;
}

export async function promptForMarkdownImportTargetPath(sourcePath: string) {
  const selectedPath = await save({
    title: "Create imported Fablecraft document",
    filters: DOCUMENT_FILTERS,
    defaultPath: `${fileStem(sourcePath)}.fable`,
  });

  if (!selectedPath) {
    return null;
  }

  return ensureFableExtension(selectedPath);
}

export async function promptForExportPath(
  documentName: string,
  format: "html" | "markdown",
  title = format === "markdown" ? "Export Markdown" : "Export HTML",
) {
  const extension = format === "markdown" ? ".md" : ".html";
  const selectedPath = await save({
    title,
    filters: [
      {
        name: format === "markdown" ? "Markdown" : "HTML",
        extensions: [extension.slice(1)],
      },
    ],
    defaultPath: `${documentName}${extension}`,
  });

  if (!selectedPath) {
    return null;
  }

  return format === "markdown"
    ? ensureMarkdownExtension(selectedPath)
    : ensureHtmlExtension(selectedPath);
}
