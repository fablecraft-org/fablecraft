import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import { useEffect, useRef } from "react";
import { trimTrailingEmptyParagraphs } from "../domain/document/content";
import { EMPTY_EDITOR_DOCUMENT_JSON } from "../domain/document/editorDocument";
import type { SplitCardContent } from "../domain/document/split";
import { listenForFrontendMenuActions } from "../lib/nativeMenu";
import { PassageAnchorMark } from "./passageAnchorMark";
import { PASSAGE_ANCHOR_MARK } from "../domain/document/passageAnchors";

interface CardEditorProps {
  canLeaveEditing?: boolean;
  canCreateStructure: boolean;
  contentJson: string;
  focusPlacement?: "start" | "end" | null;
  onCreateChild: () => void;
  onCreateAnchoredChild?: (contentForChild: (childId: string) => string) => void;
  onOpenAnchoredChild?: (childId: string) => void;
  onPassageAnchorError?: (message: string) => void;
  onCreateParentLevel: () => void;
  onCreateSiblingAbove: () => void;
  onCreateSiblingBelow: () => void;
  isEditing: boolean;
  onCreateBelow: (splitContent?: SplitCardContent) => void;
  onConsumeFocusPlacement: () => void;
  onConsumePendingTextInput: () => void;
  onDeleteEmpty: () => void;
  onRedo: () => void;
  onMergeAbove: () => boolean;
  onMergeBelow: () => boolean;
  onNavigateAbove: (placement?: "start" | "end") => boolean;
  onNavigateBelow: (placement?: "start" | "end") => boolean;
  onNavigateChild: (placement?: "start" | "end") => boolean;
  onNavigateParent: (placement?: "start" | "end") => boolean;
  pendingTextInput?: string | null;
  onRequestNavigation: () => void;
  onSplitAtSelection: (selectionStart: number, selectionEnd: number, richSplit?: SplitCardContent) => void;
  onUndo: () => void;
  onUpdateContent: (contentJson: string) => void;
  placeholder?: string;
}

let tabKeyHeldAcrossEditors = false;
let tabKeyListenersAttached = false;

function setTabKeyHeldAcrossEditors(isHeld: boolean) {
  tabKeyHeldAcrossEditors = isHeld;
}

function ensureTabKeyListeners() {
  if (tabKeyListenersAttached || typeof window === "undefined") {
    return;
  }

  window.addEventListener("keyup", (event) => {
    if (event.key === "Tab") {
      setTabKeyHeldAcrossEditors(false);
    }
  });
  window.addEventListener("blur", () => {
    setTabKeyHeldAcrossEditors(false);
  });
  tabKeyListenersAttached = true;
}

function selectionTextOffsets(editor: Editor) {
  const { doc, selection } = editor.state;
  const before = doc.textBetween(0, selection.from, "\n\n");
  const selected = doc.textBetween(selection.from, selection.to, "\n\n");

  return {
    end: before.length + selected.length,
    start: before.length,
  };
}

function editorIsEffectivelyEmpty(editor: Editor) {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n\n").trim().length === 0;
}

function editorTextLength(editor: Editor) {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n\n").length;
}

function contentAroundDivide(editor: Editor, from: number, to: number): SplitCardContent {
  const { doc } = editor.state;
  return {
    before: trimTrailingEmptyParagraphs(JSON.stringify(doc.cut(0, from).toJSON())),
    after: JSON.stringify(doc.cut(to).toJSON()),
  };
}

function insertParagraphAfterCurrentBlock(editor: Editor) {
  const { state, view } = editor;
  const paragraph = state.schema.nodes.paragraph?.create();

  if (!paragraph) {
    return false;
  }

  const insertPosition = state.selection.$from.after();
  let transaction = state.tr.insert(insertPosition, paragraph);
  transaction = transaction
    .setSelection(TextSelection.near(transaction.doc.resolve(insertPosition + 1)))
    .scrollIntoView();

  view.dispatch(transaction);
  return true;
}

function selectionIsInTrailingEmptyBlock(
  editor: Editor,
) {
  const { doc, selection } = editor.state;

  return (
    selection.empty &&
    selection.$from.parent.textContent.trim() === "" &&
    selection.$from.index(0) === doc.childCount - 1
  );
}

function trimTrailingEmptyLineFromEditor(
  editor: Editor,
) {
  const currentContentJson = JSON.stringify(editor.getJSON());
  const trimmedContentJson = trimTrailingEmptyParagraphs(currentContentJson);

  if (trimmedContentJson === currentContentJson) {
    return false;
  }

  editor.commands.setContent(JSON.parse(trimmedContentJson));
  editor.commands.focus("end");
  return true;
}

export function isSelectionAtCardBoundary(
  selectionStart: number,
  selectionEnd: number,
  textLength: number,
  direction: "up" | "down" | "right",
) {
  if (direction === "up") {
    return selectionStart === 0;
  }

  return selectionEnd === textLength;
}

export function CardEditor({
  canLeaveEditing = true,
  canCreateStructure,
  contentJson,
  focusPlacement = null,
  onCreateChild,
  onCreateAnchoredChild,
  onOpenAnchoredChild,
  onPassageAnchorError,
  onCreateParentLevel,
  onCreateSiblingAbove,
  onCreateSiblingBelow,
  isEditing,
  onCreateBelow,
  onConsumeFocusPlacement,
  onConsumePendingTextInput,
  onDeleteEmpty,
  onRedo,
  onMergeAbove,
  onMergeBelow,
  onNavigateAbove,
  onNavigateBelow,
  onNavigateChild,
  onNavigateParent,
  pendingTextInput = null,
  onRequestNavigation,
  onSplitAtSelection,
  onUndo,
  onUpdateContent,
  placeholder = "",
}: CardEditorProps) {
  ensureTabKeyListeners();
  const tabHeldRef = useRef(false);
  const wasEditingRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const isTabHeld = () => tabHeldRef.current || tabKeyHeldAcrossEditors;
  function createOrOpenPassageAnchor(currentEditor: Editor) {
    const { state } = currentEditor;
    const { from, to, empty, $from } = state.selection;
    if (empty) {
      const anchor = $from.marks().find((mark) => mark.type.name === PASSAGE_ANCHOR_MARK);
      if (anchor) onOpenAnchoredChild?.(anchor.attrs.childCardId);
      return;
    }
    const existingIds = new Set<string>();
    let hasUnanchoredText = false;
    let unsupportedFormatting = false;
    const anchorType = state.schema.marks[PASSAGE_ANCHOR_MARK]!;
    state.doc.nodesBetween(from, to, (node, _position, parent) => {
      if (!node.isText) return;
      if (!parent?.type.allowsMarkType(anchorType) || node.marks.some((mark) => mark.type.excludes(anchorType))) {
        unsupportedFormatting = true;
      }
      const anchor = node.marks.find((mark) => mark.type.name === PASSAGE_ANCHOR_MARK);
      if (anchor) existingIds.add(anchor.attrs.childCardId);
      else hasUnanchoredText = true;
    });
    if (existingIds.size === 1 && !hasUnanchoredText) {
      onOpenAnchoredChild?.([...existingIds][0]!);
      return;
    }
    if (existingIds.size > 0) {
      onPassageAnchorError?.("Choose a passage that does not overlap an existing highlighted passage.");
      return;
    }
    if (unsupportedFormatting) {
      onPassageAnchorError?.("Choose a passage outside code formatting to create an associated child.");
      return;
    }
    if (!canCreateStructure || !state.doc.textBetween(from, to).trim()) return;
    // Build the marked document without dispatching: the workspace commits the
    // source text and new child together as one editing-history operation.
    onCreateAnchoredChild?.((childCardId) => JSON.stringify(
      state.tr.addMark(from, to, anchorType.create({ childCardId })).doc.toJSON(),
    ));
  }
  const editor = useEditor({
    autofocus: false,
    content: JSON.parse(contentJson),
    editorProps: {
      attributes: {
        class:
          "fc-editor w-full min-h-[1.5rem] outline-none font-[var(--fc-font-content)] text-[length:var(--fc-content-size)] leading-[var(--fc-content-line-height)] text-[var(--fc-color-text)]",
      },
      handleDOMEvents: {
        click(_, event) {
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-fc-child-id]") : null;
          const childId = target?.dataset.fcChildId;
          if (!childId || !onOpenAnchoredChild) return false;
          event.preventDefault();
          event.stopPropagation();
          onOpenAnchoredChild(childId);
          return true;
        },
      },
      transformPasted(slice) {
        // Rich-text paste copies prose, never a reference into the source tree.
        const strip = (fragment: Fragment): Fragment =>
          Fragment.fromArray(fragment.content.map((node) =>
            node.copy(strip(node.content)).mark(node.marks.filter((mark) => mark.type.name !== PASSAGE_ANCHOR_MARK))));
        return new Slice(strip(slice.content), slice.openStart, slice.openEnd);
      },
      handleKeyDown(_, event): boolean {
        const currentEditor = editorRef.current;

        if (!currentEditor) {
          return false;
        }

        if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey &&
          (event.code === "KeyM" || event.key.toLowerCase() === "m")) {
          event.preventDefault();
          createOrOpenPassageAnchor(currentEditor);
          return true;
        }

        if (event.key === "Escape") {
          if (!canLeaveEditing) {
            event.preventDefault();
            return true;
          }

          event.preventDefault();
          onRequestNavigation();
          return true;
        }

        if (
          (event.metaKey || event.ctrlKey) &&
          event.altKey === false &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();

          if (event.shiftKey) {
            onRedo();
          } else {
            onUndo();
          }

          return true;
        }

        if (
          event.altKey &&
          event.metaKey === false &&
          event.ctrlKey === false &&
          event.shiftKey === false &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          const merged =
            event.key === "ArrowUp" ? onMergeAbove() : onMergeBelow();

          if (merged) {
            event.preventDefault();
            return true;
          }
        }

        if (isTabHeld() && event.key === "ArrowUp") {
          event.preventDefault();
          if (canCreateStructure) {
            onCreateSiblingAbove();
          }
          return true;
        }

        if (isTabHeld() && event.key === "ArrowDown") {
          event.preventDefault();
          if (canCreateStructure) {
            onCreateSiblingBelow();
          }
          return true;
        }

        if (isTabHeld() && event.key === "ArrowRight") {
          event.preventDefault();
          if (!currentEditor.state.selection.empty) {
            createOrOpenPassageAnchor(currentEditor);
            return true;
          }
          if (canCreateStructure) {
            onCreateChild();
          }
          return true;
        }

        if (isTabHeld() && event.key === "ArrowLeft") {
          event.preventDefault();
          if (canCreateStructure) {
            onCreateParentLevel();
          }
          return true;
        }

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const offsets = selectionTextOffsets(currentEditor);
          const direction = event.key === "ArrowUp" ? "up" : "down";

          if (
            currentEditor.state.selection.empty &&
            isSelectionAtCardBoundary(
              offsets.start,
              offsets.end,
              editorTextLength(currentEditor),
              direction,
            )
          ) {
            const moved =
              direction === "up" ? onNavigateAbove() : onNavigateBelow();

            if (moved) {
              event.preventDefault();
              return true;
            }
          }
        }

        if (event.key === "ArrowRight") {
          const offsets = selectionTextOffsets(currentEditor);

          if (
            currentEditor.state.selection.empty &&
            isSelectionAtCardBoundary(
              offsets.start,
              offsets.end,
              editorTextLength(currentEditor),
              "right",
            )
          ) {
            const moved = onNavigateChild();

            if (moved) {
              event.preventDefault();
              return true;
            }
          }
        }

        if (
          event.key === "Backspace" &&
          event.metaKey === false &&
          event.ctrlKey === false &&
          event.altKey === false &&
          editorIsEffectivelyEmpty(currentEditor)
        ) {
          event.preventDefault();
          onDeleteEmpty();
          return true;
        }

        if (
          event.key === "Backspace" &&
          event.metaKey === false &&
          event.ctrlKey === false &&
          event.altKey === false &&
          selectionIsInTrailingEmptyBlock(currentEditor) &&
          trimTrailingEmptyLineFromEditor(currentEditor)
        ) {
          event.preventDefault();
          return true;
        }

        if (event.key === "Tab") {
          event.preventDefault();
          tabHeldRef.current = true;
          setTabKeyHeldAcrossEditors(true);
          return true;
        }

        if (event.key === "Enter" && event.shiftKey === false && event.altKey === false && event.metaKey === false && event.ctrlKey === false) {
          if (tabHeldRef.current) {
            event.preventDefault();
            if (!canCreateStructure) {
              return true;
            }

            const offsets = selectionTextOffsets(currentEditor);
            onSplitAtSelection(offsets.start, offsets.end,
              JSON.stringify(currentEditor.getJSON()).includes(PASSAGE_ANCHOR_MARK)
                ? contentAroundDivide(currentEditor, currentEditor.state.selection.from, currentEditor.state.selection.to)
                : undefined);
            return true;
          }

          const { doc, selection } = currentEditor.state;
          const blockIndex = selection.$from.index(0);
          const previousBlock = blockIndex > 0 ? doc.child(blockIndex - 1) : null;

          // Repeated Enter in the middle of text leaves the caret at the start
          // of the lower paragraph, with the blank divide just before it.
          if (
            selection.empty &&
            selection.$from.depth === 1 &&
            selection.$from.parentOffset === 0 &&
            previousBlock?.type.name === "paragraph" &&
            previousBlock.content.size === 0
          ) {
            event.preventDefault();
            if (canCreateStructure) {
              const lowerStart = selection.$from.before(1);
              onCreateBelow(contentAroundDivide(
                currentEditor,
                lowerStart - previousBlock.nodeSize,
                lowerStart,
              ));
            }
            return true;
          }

          const isEmptyHeading =
            currentEditor.state.selection.empty &&
            currentEditor.state.selection.$from.parent.type.name === "heading" &&
            currentEditor.state.selection.$from.parent.textContent.trim() === "";

          if (isEmptyHeading) {
            event.preventDefault();
            currentEditor.commands.setContent(JSON.parse(EMPTY_EDITOR_DOCUMENT_JSON));
            currentEditor.commands.focus("end");
            return true;
          }

          if (
            currentEditor.state.selection.empty &&
            currentEditor.state.selection.$from.parent.type.name === "heading"
          ) {
            event.preventDefault();
            return insertParagraphAfterCurrentBlock(currentEditor);
          }

          const isEmptyParagraph =
            currentEditor.state.selection.empty &&
            currentEditor.state.selection.$from.parent.type.name === "paragraph" &&
            currentEditor.state.selection.$from.parent.textContent.trim() === "";

          if (isEmptyParagraph) {
            event.preventDefault();
            if (!canCreateStructure) {
              return true;
            }

            if (selection.$from.depth === 1 && selection.$from.index(0) < doc.childCount - 1) {
              // Move the lower blocks directly from the live editor so marks and
              // block structure survive, including text typed before React renders.
              onCreateBelow(contentAroundDivide(
                currentEditor,
                selection.$from.before(1),
                selection.$from.after(1),
              ));
            } else {
              onCreateBelow();
            }
            return true;
          }
        }

        return false;
      },
    },
    extensions: [
      PassageAnchorMark,
      Placeholder.configure({
        emptyEditorClass: "is-editor-empty",
        placeholder,
      }),
      StarterKit.configure({
        trailingNode: {
          notAfter: ["heading"],
        },
      }),
    ],
    immediatelyRender: false,
    onFocus() {
      if (!isEditing) {
        // The workspace owns mode transitions; this editor just keeps the caret ready.
      }
    },
    onUpdate({ editor: nextEditor }) {
      onUpdateContent(JSON.stringify(nextEditor.getJSON()));
    },
  });

  editorRef.current = editor;

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(isEditing);

    if (isEditing && !wasEditingRef.current) {
      editor.commands.focus("end");
    } else if (!isEditing && wasEditingRef.current) {
      editor.commands.blur();
    }

    wasEditingRef.current = isEditing;
  }, [editor, isEditing]);

  useEffect(() => {
    if (!editor || !isEditing || !focusPlacement) {
      return;
    }

    editor.commands.focus(focusPlacement);
    onConsumeFocusPlacement();
  }, [editor, focusPlacement, isEditing, onConsumeFocusPlacement]);

  useEffect(() => {
    if (!editor || !isEditing || !pendingTextInput) {
      return;
    }

    editor.commands.insertContent(pendingTextInput);
    onConsumePendingTextInput();
  }, [editor, isEditing, onConsumePendingTextInput, pendingTextInput]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const currentJson = JSON.stringify(editor.getJSON());

    if (currentJson !== contentJson) {
      editor.commands.setContent(JSON.parse(contentJson), { emitUpdate: false });
    }
  }, [contentJson, editor]);

  useEffect(() => {
    if (!editor || !isEditing) {
      return;
    }

    return listenForFrontendMenuActions((action) => {
      if (action === "create-anchored-child") {
        createOrOpenPassageAnchor(editor);
        return;
      }
      if (action === "undo") {
        onUndo();
        return;
      }

      if (action === "redo") {
        onRedo();
        return;
      }

      if (action === "split" && canCreateStructure) {
        const offsets = selectionTextOffsets(editor);
        onSplitAtSelection(offsets.start, offsets.end,
          JSON.stringify(editor.getJSON()).includes(PASSAGE_ANCHOR_MARK)
            ? contentAroundDivide(editor, editor.state.selection.from, editor.state.selection.to)
            : undefined);
      }
    });
  }, [canCreateStructure, editor, isEditing, onRedo, onSplitAtSelection, onUndo,
    onCreateAnchoredChild, onOpenAnchoredChild, onPassageAnchorError]);

  if (!editor) {
    return null;
  }

  return <EditorContent className="w-full" editor={editor} />;
}
