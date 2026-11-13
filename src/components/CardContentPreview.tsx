import { Fragment, type ReactNode } from "react";
import { contentText } from "../domain/document/content";

interface AnchorPresentation {
  activeAnchoredChildId?: string;
  onOpenAnchoredChild?: (childId: string) => void;
}

interface PreviewMark {
  attrs?: Record<string, unknown>;
  type?: string;
}

interface PreviewNode {
  attrs?: Record<string, unknown>;
  content?: PreviewNode[];
  marks?: PreviewMark[];
  text?: string;
  type?: string;
}

function parsePreviewDocument(contentJson: string) {
  try {
    return JSON.parse(contentJson) as PreviewNode;
  } catch {
    return null;
  }
}

function applyMarks(content: ReactNode, marks: PreviewMark[], anchors: AnchorPresentation) {
  return marks.reduce<ReactNode>((wrappedContent, mark, index) => {
    if (mark.type === "passageAnchor" && typeof mark.attrs?.childCardId === "string") {
      const childId = mark.attrs.childCardId;
      const open = () => anchors.onOpenAnchoredChild?.(childId);
      return (
        <span
          className={`fc-passage-anchor${anchors.activeAnchoredChildId === childId ? " fc-passage-anchor-active" : ""}`}
          data-fc-child-id={childId}
          key={`anchor-${index}`}
          role="link"
          tabIndex={anchors.onOpenAnchoredChild ? 0 : undefined}
          aria-label="Open associated child card"
          onClick={(event) => { event.stopPropagation(); open(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              open();
            }
          }}
        >{wrappedContent}</span>
      );
    }

    if (mark.type === "bold") {
      return <strong key={`bold-${index}`}>{wrappedContent}</strong>;
    }

    if (mark.type === "italic") {
      return <em key={`italic-${index}`}>{wrappedContent}</em>;
    }

    if (mark.type === "strike") {
      return <s key={`strike-${index}`}>{wrappedContent}</s>;
    }

    if (mark.type === "code") {
      return (
        <code
          className="rounded-[8px] bg-[var(--fc-color-surface-strong)] px-1 py-[1px]"
          key={`code-${index}`}
        >
          {wrappedContent}
        </code>
      );
    }

    if (mark.type === "link") {
      return (
        <span className="underline" key={`link-${index}`}>
          {wrappedContent}
        </span>
      );
    }

    return wrappedContent;
  }, content);
}

function renderChildren(nodes: PreviewNode[], keyPrefix: string, anchors: AnchorPresentation) {
  return nodes.map((node, index) => renderNode(node, `${keyPrefix}-${index}`, anchors));
}

function renderNode(node: PreviewNode, key: string, anchors: AnchorPresentation): ReactNode {
  if (node.type === "text") {
    return (
      <Fragment key={key}>
        {applyMarks(node.text ?? "", node.marks ?? [], anchors)}
      </Fragment>
    );
  }

  if (node.type === "hardBreak") {
    return <br key={key} />;
  }

  const children = renderChildren(node.content ?? [], key, anchors);

  if (node.type === "doc") {
    return <Fragment key={key}>{children}</Fragment>;
  }

  if (node.type === "paragraph") {
    return (
      <p className="m-0 whitespace-pre-wrap" key={key}>
        {children.length > 0 ? children : <br />}
      </p>
    );
  }

  if (node.type === "heading") {
    const requestedLevel = Number(node.attrs?.level ?? 1);
    const level = Math.min(3, Math.max(1, requestedLevel));

    if (level === 1) {
      return (
        <h1 className="m-0 whitespace-pre-wrap" key={key}>
          {children.length > 0 ? children : <br />}
        </h1>
      );
    }

    if (level === 2) {
      return (
        <h2 className="m-0 whitespace-pre-wrap" key={key}>
          {children.length > 0 ? children : <br />}
        </h2>
      );
    }

    return (
      <h3 className="m-0 whitespace-pre-wrap" key={key}>
        {children.length > 0 ? children : <br />}
      </h3>
    );
  }

  if (node.type === "bulletList") {
    return <ul key={key}>{children}</ul>;
  }

  if (node.type === "orderedList") {
    return <ol key={key}>{children}</ol>;
  }

  if (node.type === "listItem") {
    return <li key={key}>{children.length > 0 ? children : <br />}</li>;
  }

  if (node.type === "blockquote") {
    return (
      <blockquote
        className="border-l-2 border-[var(--fc-color-border)] pl-4 italic"
        key={key}
      >
        {children.length > 0 ? children : <br />}
      </blockquote>
    );
  }

  if (node.type === "codeBlock") {
    return (
      <pre
        className="m-0 whitespace-pre-wrap rounded-[14px] bg-[var(--fc-color-surface-strong)] px-4 py-3 text-[0.95em]"
        key={key}
      >
        <code>{children.length > 0 ? children : node.text ?? ""}</code>
      </pre>
    );
  }

  return <Fragment key={key}>{children}</Fragment>;
}

interface CardContentPreviewProps extends AnchorPresentation {
  contentJson: string;
  placeholder?: string;
}

export function CardContentPreview({
  contentJson,
  placeholder = "",
  activeAnchoredChildId,
  onOpenAnchoredChild,
}: CardContentPreviewProps) {
  const fallbackText = contentText(contentJson);

  if (placeholder && fallbackText.trim().length === 0) {
    return (
      <div className="fc-editor fc-preview text-[length:var(--fc-content-size)] leading-[var(--fc-content-line-height)] text-[var(--fc-color-muted)]">
        <p className="m-0 whitespace-pre-wrap italic">{placeholder}</p>
      </div>
    );
  }

  const previewDocument = parsePreviewDocument(contentJson);

  if (!previewDocument) {
    return (
      <div className="fc-editor fc-preview text-[length:var(--fc-content-size)] leading-[var(--fc-content-line-height)] text-[var(--fc-color-text)]">
        <p className="m-0 whitespace-pre-wrap">{fallbackText}</p>
      </div>
    );
  }

  return (
    <div className="fc-editor fc-preview text-[length:var(--fc-content-size)] leading-[var(--fc-content-line-height)] text-[var(--fc-color-text)]">
      {renderNode(previewDocument, "root", { activeAnchoredChildId, onOpenAnchoredChild })}
    </div>
  );
}
