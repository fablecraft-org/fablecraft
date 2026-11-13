import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardEditor } from "../src/components/CardEditor";
import { contentJsonForPlainText, contentText } from "../src/domain/document/content";
import { NEW_CARD_EDITOR_DOCUMENT_JSON } from "../src/domain/document/editorDocument";
import { dispatchNativeMenuAction } from "../src/lib/nativeMenu";

const EMPTY_HEADING_JSON = JSON.stringify({
  type: "doc",
  content: [{ type: "heading", attrs: { level: 1 } }],
});

function renderEditor(
  overrides: Partial<ComponentProps<typeof CardEditor>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const props: ComponentProps<typeof CardEditor> = {
    canCreateStructure: true,
    canLeaveEditing: true,
    contentJson: contentJsonForPlainText("Hello world"),
    focusPlacement: null,
    isEditing: true,
    onConsumeFocusPlacement: vi.fn(),
    onConsumePendingTextInput: vi.fn(),
    onCreateBelow: vi.fn(),
    onCreateChild: vi.fn(),
    onCreateParentLevel: vi.fn(),
    onCreateSiblingAbove: vi.fn(),
    onCreateSiblingBelow: vi.fn(),
    onDeleteEmpty: vi.fn(),
    onRedo: vi.fn(),
    onMergeAbove: vi.fn(() => false),
    onMergeBelow: vi.fn(() => false),
    onNavigateAbove: vi.fn(() => false),
    onNavigateBelow: vi.fn(() => false),
    onNavigateChild: vi.fn(() => false),
    onNavigateParent: vi.fn(() => false),
    onRequestNavigation: vi.fn(),
    onSplitAtSelection: vi.fn(),
    onUndo: vi.fn(),
    onUpdateContent: vi.fn(),
    placeholder: "",
    pendingTextInput: null,
    ...overrides,
  };

  return { container, props, root };
}

describe("CardEditor keyboard behavior", () => {
  const originalActEnvironment = (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab" }));
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    document.body.innerHTML = "";
  });

  it.each(["shortcut", "tab", "native-menu"])("creates an anchored selection through %s without separately saving the source mark", async (trigger) => {
    const onCreateAnchoredChild = vi.fn();
    const { container, props, root } = renderEditor({ onCreateAnchoredChild });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      element.editor.commands.setTextSelection({ from: 1, to: 6 });
      vi.mocked(props.onUpdateContent).mockClear();
      if (trigger === "native-menu") {
        dispatchNativeMenuAction("create-anchored-child");
        return;
      }
      if (trigger === "tab") element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      element.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true,
        key: trigger === "tab" ? "ArrowRight" : "µ", code: trigger === "tab" ? "ArrowRight" : "KeyM",
        metaKey: trigger === "shortcut", altKey: trigger === "shortcut",
      }));
    });
    expect(onCreateAnchoredChild).toHaveBeenCalledTimes(1);
    const contentForChild = onCreateAnchoredChild.mock.lastCall![0];
    const marked = contentForChild("new-child");
    expect(contentText(marked)).toBe("Hello world");
    expect(JSON.parse(marked).content[0].content[0]).toMatchObject({
      text: "Hello", marks: [{ type: "passageAnchor", attrs: { childCardId: "new-child" } }],
    });
    expect(props.onUpdateContent).not.toHaveBeenCalled();
    expect(props.onNavigateChild).not.toHaveBeenCalled();
    expect(props.onCreateChild).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("renders persistent anchors, opens their target and rejects overlapping selection", async () => {
    const contentJson = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Hello", marks: [{ type: "passageAnchor", attrs: { childCardId: "child" } }] },
      { type: "text", text: " world" },
    ] }] });
    const onOpenAnchoredChild = vi.fn();
    const onPassageAnchorError = vi.fn();
    const onCreateAnchoredChild = vi.fn();
    const { container, props, root } = renderEditor({ contentJson, onOpenAnchoredChild, onPassageAnchorError, onCreateAnchoredChild });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    const command = () => element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, code: "KeyM", key: "m", metaKey: true, altKey: true,
    }));
    expect(element.querySelector(".fc-passage-anchor")?.textContent).toBe("Hello");
    await act(async () => { element.editor.commands.setTextSelection(3); });
    expect(element.querySelector(".fc-passage-anchor-active")?.textContent).toBe("Hello");
    await act(async () => { command(); });
    expect(onOpenAnchoredChild).toHaveBeenLastCalledWith("child");
    await act(async () => { element.editor.commands.setTextSelection(10); });
    expect(element.querySelector(".fc-passage-anchor-active")).toBeNull();
    await act(async () => { (element.querySelector(".fc-passage-anchor") as HTMLElement).click(); });
    expect(onOpenAnchoredChild).toHaveBeenLastCalledWith("child");
    await act(async () => {
      element.editor.commands.setTextSelection({ from: 3, to: 9 });
      command();
    });
    expect(onPassageAnchorError).toHaveBeenCalledTimes(1);
    expect(onCreateAnchoredChild).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("keeps anchor marks through text edits and rich splits, strips them from pasted prose", async () => {
    const contentJson = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Hello", marks: [{ type: "bold" }, { type: "passageAnchor", attrs: { childCardId: "child" } }] },
      { type: "text", text: " world" },
    ] }] });
    const { container, props, root } = renderEditor({ contentJson });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    const { editor } = element;
    await act(async () => {
      editor.commands.setTextSelection(3);
      editor.commands.insertContent("X");
    });
    expect(element.querySelector(".fc-passage-anchor")?.textContent).toBe("HeXllo");
    const selection = editor.state.doc.slice(1, 7);
    let transformed = selection;
    editor.view.someProp("transformPasted", (transform) => { transformed = transform(selection, editor.view, false); });
    expect(JSON.stringify(transformed.toJSON())).not.toContain("passageAnchor");
    expect(JSON.stringify(transformed.toJSON())).toContain("bold");
    await act(async () => {
      editor.commands.setTextSelection(8);
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    const richSplit = vi.mocked(props.onSplitAtSelection).mock.lastCall?.[2];
    expect(richSplit?.before).toContain("passageAnchor");
    expect(contentText(richSplit?.before ?? "")).toBe("HeXllo ");
    await act(async () => { root.unmount(); });
  });

  it("rejects code selections without creating an unanchored child or losing formatting", async () => {
    const contentJson = JSON.stringify({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "Code" }] }] });
    const onCreateAnchoredChild = vi.fn();
    const onPassageAnchorError = vi.fn();
    const { container, props, root } = renderEditor({ contentJson, onCreateAnchoredChild, onPassageAnchorError });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      element.editor.commands.setTextSelection({ from: 1, to: 5 });
      dispatchNativeMenuAction("create-anchored-child");
    });
    expect(onCreateAnchoredChild).not.toHaveBeenCalled();
    expect(onPassageAnchorError).toHaveBeenCalledTimes(1);
    expect(element.querySelector("pre")?.textContent).toBe("Code");
    await act(async () => { root.unmount(); });
  });

  it.each(([
    { key: "ArrowUp", create: "onCreateSiblingAbove", navigate: "onNavigateAbove" },
    { key: "ArrowDown", create: "onCreateSiblingBelow", navigate: "onNavigateBelow" },
    { key: "ArrowLeft", create: "onCreateParentLevel", navigate: "onNavigateParent" },
    { key: "ArrowRight", create: "onCreateChild", navigate: "onNavigateChild" },
  ] as const).flatMap((direction) => [true, false].map((canCreateStructure) => ({ ...direction, canCreateStructure }))))(
    "Tab+$key creates instead of navigating when creation is allowed=$canCreateStructure", async ({ key, create, navigate, canCreateStructure }) => {
      const { container, props, root } = renderEditor({
        canCreateStructure,
        onNavigateAbove: vi.fn(() => true),
        onNavigateBelow: vi.fn(() => true),
        onNavigateParent: vi.fn(() => true),
        onNavigateChild: vi.fn(() => true),
      });
      await act(async () => { root.render(<CardEditor {...props} />); });
      const element = container.querySelector(".ProseMirror") as HTMLElement;
      await act(async () => {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab", cancelable: true }));
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, cancelable: true }));
      });
      expect(props[create]).toHaveBeenCalledTimes(canCreateStructure ? 1 : 0);
      expect(props[navigate]).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); });
    },
  );

  it("uses Tab+ArrowDown to create a sibling even when a card exists below", async () => {
    const { container, props, root } = renderEditor({
      onNavigateBelow: vi.fn(() => true),
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement).not.toBeNull();

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    expect(props.onNavigateBelow).not.toHaveBeenCalled();
    expect(props.onCreateSiblingBelow).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("lets Cmd+ArrowRight keep its native editor behavior", async () => {
    const { container, props, root } = renderEditor();

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement).not.toBeNull();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
      metaKey: true,
    });

    await act(async () => {
      editorElement?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(props.onCreateChild).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Tab+ArrowRight to create a child when no child exists", async () => {
    const { container, props, root } = renderEditor({
      onNavigateChild: vi.fn(() => false),
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement).not.toBeNull();

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(props.onNavigateChild).not.toHaveBeenCalled();
    expect(props.onCreateChild).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("starts new cards with normal text when typing", async () => {
    const { container, props, root } = renderEditor({
      contentJson: NEW_CARD_EDITOR_DOCUMENT_JSON,
    });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => { element.editor.commands.insertContent("Ordinary text"); });
    expect(element.querySelector("p")?.textContent).toBe("Ordinary text");
    expect(element.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it.each([1, 2, 3])("turns a new card into a level %i heading only after a Markdown marker and space", async (level) => {
    const { container, props, root } = renderEditor({
      contentJson: NEW_CARD_EDITOR_DOCUMENT_JSON,
    });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      element.editor.commands.insertContent("#".repeat(level));
    });
    expect(element.querySelector("p")?.textContent).toBe("#".repeat(level));
    expect(element.querySelector("h1, h2, h3")).toBeNull();
    await act(async () => {
      const view = element.editor.view;
      const { from, to } = view.state.selection;
      view.someProp("handleTextInput", (handler) => handler(
        view, from, to, " ", () => view.state.tr.insertText(" ", from, to),
      ));
    });
    expect(element.querySelector(`h${level}`)).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("turns an empty Markdown heading into regular text on Enter", async () => {
    const { container, props, root } = renderEditor({
      contentJson: EMPTY_HEADING_JSON,
      focusPlacement: "end",
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement?.querySelector("h1")).not.toBeNull();
    expect(editorElement?.querySelectorAll("p")).toHaveLength(0);

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    const latestContentJson = vi.mocked(props.onUpdateContent).mock.lastCall?.[0];

    expect(props.onCreateBelow).not.toHaveBeenCalled();
    if (!latestContentJson) {
      throw new Error("Expected the editor to publish updated paragraph content.");
    }
    expect(JSON.parse(latestContentJson)).toEqual({
      content: [{ type: "paragraph" }],
      type: "doc",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps a written heading and starts regular text below on Enter", async () => {
    const { container, props, root } = renderEditor({
      contentJson: JSON.stringify({
        content: [
          {
            attrs: { level: 1 },
            content: [{ text: "Scene title", type: "text" }],
            type: "heading",
          },
        ],
        type: "doc",
      }),
      focusPlacement: "end",
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement?.querySelector("h1")?.textContent).toBe("Scene title");
    expect(editorElement?.querySelectorAll("p")).toHaveLength(0);

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    const latestContentJson = vi.mocked(props.onUpdateContent).mock.lastCall?.[0];

    expect(props.onCreateBelow).not.toHaveBeenCalled();
    if (!latestContentJson) {
      throw new Error("Expected the editor to publish a body paragraph below the heading.");
    }
    expect(JSON.parse(latestContentJson)).toEqual({
      content: [
        {
          attrs: { level: 1 },
          content: [{ text: "Scene title", type: "text" }],
          type: "heading",
        },
        { type: "paragraph" },
      ],
      type: "doc",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("turns an empty heading into regular text on Enter after Tab-key creation", async () => {
    const setup = renderEditor();

    await act(async () => {
      setup.root.render(<CardEditor {...setup.props} />);
    });

    const setupEditorElement = setup.container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      setupEditorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      setup.root.unmount();
    });

    const { container, props, root } = renderEditor({
      contentJson: EMPTY_HEADING_JSON,
      focusPlacement: "end",
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    const latestContentJson = vi.mocked(props.onUpdateContent).mock.lastCall?.[0];

    expect(props.onSplitAtSelection).not.toHaveBeenCalled();
    expect(props.onCreateBelow).not.toHaveBeenCalled();
    if (!latestContentJson) {
      throw new Error("Expected the stale Tab state to preserve normal heading Enter behavior.");
    }
    expect(JSON.parse(latestContentJson)).toEqual({
      content: [{ type: "paragraph" }],
      type: "doc",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps a written heading as a heading on Enter after Tab-key creation", async () => {
    const setup = renderEditor();

    await act(async () => {
      setup.root.render(<CardEditor {...setup.props} />);
    });

    const setupEditorElement = setup.container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      setupEditorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      setup.root.unmount();
    });

    const { container, props, root } = renderEditor({
      contentJson: JSON.stringify({
        content: [
          {
            attrs: { level: 1 },
            content: [{ text: "Scene title", type: "text" }],
            type: "heading",
          },
        ],
        type: "doc",
      }),
      focusPlacement: "end",
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });

    const latestContentJson = vi.mocked(props.onUpdateContent).mock.lastCall?.[0];

    expect(props.onSplitAtSelection).not.toHaveBeenCalled();
    expect(props.onCreateBelow).not.toHaveBeenCalled();
    if (!latestContentJson) {
      throw new Error("Expected the stale Tab state to insert a body paragraph.");
    }
    expect(JSON.parse(latestContentJson)).toEqual({
      content: [
        {
          attrs: { level: 1 },
          content: [{ text: "Scene title", type: "text" }],
          type: "heading",
        },
        { type: "paragraph" },
      ],
      type: "doc",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("splits around three Enters within text and keeps the caret before the lower rich text", async () => {
    const { container, props, root } = renderEditor({
      contentJson: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [
          { type: "text", text: "Above" },
          { type: "text", text: "Below", marks: [{ type: "bold" }] },
        ] }],
      }),
    });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      element.editor.commands.setTextSelection(6);
      for (let index = 0; index < 3; index += 1) {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
      }
    });

    expect(props.onCreateBelow).toHaveBeenCalledTimes(1);
    const split = vi.mocked(props.onCreateBelow).mock.lastCall?.[0];
    if (!split) throw new Error("Expected a split with both sections.");
    expect(contentText(split.before)).toBe("Above");
    expect(JSON.parse(split.after)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "text", text: "Below", marks: [{ type: "bold" }] },
      ] }],
    });

    await act(async () => {
      root.render(<CardEditor key="lower" {...props} contentJson={split.after} focusPlacement="start" />);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const lower = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    expect(lower.editor.state.selection.from).toBe(1);
    expect(lower.editor.state.selection.empty).toBe(true);
    expect(lower.getAttribute("contenteditable")).toBe("true");
    await act(async () => { root.unmount(); });
  });

  it("moves all rich blocks below an internal blank paragraph into the new card", async () => {
    const lowerBlocks = [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Below" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [
        { type: "paragraph", content: [{ type: "text", text: "List item" }] },
      ] }] },
    ];
    const { container, props, root } = renderEditor({
      contentJson: JSON.stringify({ type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Above" }] },
        { type: "paragraph" },
        ...lowerBlocks,
      ] }),
    });
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      element.editor.commands.setTextSelection(8);
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    const split = vi.mocked(props.onCreateBelow).mock.lastCall?.[0];
    if (!split) throw new Error("Expected a split with both sections.");
    expect(contentText(split.before)).toBe("Above");
    expect(JSON.parse(split.after).content.slice(0, 2)).toEqual(lowerBlocks);
    await act(async () => { root.unmount(); });
  });

  it("still creates an empty sibling when double Enter is pressed at the end", async () => {
    const { container, props, root } = renderEditor();
    await act(async () => { root.render(<CardEditor {...props} />); });
    const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    await act(async () => {
      element.editor.commands.setTextSelection(element.editor.state.doc.content.size - 1);
      for (let index = 0; index < 2; index += 1) {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      }
    });
    expect(props.onCreateBelow).toHaveBeenCalledTimes(1);
    expect(props.onCreateBelow).toHaveBeenCalledWith();
    await act(async () => { root.unmount(); });
  });

  it("uses Option+ArrowUp to merge with the card above", async () => {
    const { container, props, root } = renderEditor({
      onMergeAbove: vi.fn(() => true),
      onNavigateAbove: vi.fn(() => false),
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement).not.toBeNull();

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          altKey: true,
          bubbles: true,
          key: "ArrowUp",
        }),
      );
    });

    expect(props.onMergeAbove).toHaveBeenCalledTimes(1);
    expect(props.onNavigateAbove).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Cmd+Z to trigger editor undo through the shared history path", async () => {
    const { container, props, root } = renderEditor();

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "z",
          metaKey: true,
        }),
      );
    });

    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps editing active on Escape for the empty first card", async () => {
    const { container, props, root } = renderEditor({
      canLeaveEditing: false,
      contentJson: '{"type":"doc","content":[{"type":"paragraph"}]}',
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });

    expect(props.onRequestNavigation).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("trims the trailing empty line immediately when Backspace returns to the previous line", async () => {
    const { container, props, root } = renderEditor({
      contentJson: JSON.stringify({
        content: [
          { content: [{ text: "Keep", type: "text" }], type: "paragraph" },
          { type: "paragraph" },
        ],
        type: "doc",
      }),
      focusPlacement: "end",
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Backspace",
    });

    await act(async () => {
      editorElement?.dispatchEvent(event);
    });

    const latestContentJson = vi.mocked(props.onUpdateContent).mock.lastCall?.[0];

    expect(event.defaultPrevented).toBe(true);
    expect(props.onDeleteEmpty).not.toHaveBeenCalled();
    if (!latestContentJson) {
      throw new Error("Expected Backspace to publish trimmed content.");
    }
    expect(contentText(latestContentJson)).toBe("Keep");
    expect(JSON.parse(latestContentJson)).toEqual({
      content: [
        { content: [{ text: "Keep", type: "text" }], type: "paragraph" },
      ],
      type: "doc",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("moves to the first child when ArrowRight is pressed at the end of the text", async () => {
    const { container, props, root } = renderEditor({
      onNavigateChild: vi.fn(() => true),
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement).not.toBeNull();

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(props.onNavigateChild).toHaveBeenCalledTimes(1);
    expect(props.onNavigateChild).toHaveBeenCalledWith();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses Tab+ArrowRight to create a child even when a child already exists", async () => {
    const { container, props, root } = renderEditor({
      onNavigateChild: vi.fn(() => true),
    });

    await act(async () => {
      root.render(<CardEditor {...props} />);
    });

    const editorElement = container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(editorElement).not.toBeNull();

    await act(async () => {
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      editorElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(props.onNavigateChild).not.toHaveBeenCalled();
    expect(props.onCreateChild).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps Tab-held creation active after the editor remounts", async () => {
    const firstProps = renderEditor({
      onNavigateBelow: vi.fn(() => true),
    });

    await act(async () => {
      firstProps.root.render(<CardEditor key="first" {...firstProps.props} />);
    });

    const firstEditor = firstProps.container.querySelector(".ProseMirror") as HTMLElement | null;

    expect(firstEditor).not.toBeNull();

    await act(async () => {
      firstEditor?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
        }),
      );
      firstEditor?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });

    const secondProps = {
      ...firstProps.props,
      contentJson: contentJsonForPlainText("Next card"),
      onNavigateChild: vi.fn(() => true),
    };

    await act(async () => {
      firstProps.root.render(<CardEditor key="second" {...secondProps} />);
    });

    const secondEditor = firstProps.container.querySelector(".ProseMirror") as HTMLElement | null;

    await act(async () => {
      secondEditor?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(firstProps.props.onNavigateBelow).not.toHaveBeenCalled();
    expect(firstProps.props.onCreateSiblingBelow).toHaveBeenCalledTimes(1);
    expect(secondProps.onNavigateChild).not.toHaveBeenCalled();
    expect(secondProps.onCreateChild).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstProps.root.unmount();
    });
  });
});
