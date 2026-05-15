import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { CardContentPreview } from "./CardContentPreview";
import { contentTitlePreview } from "../domain/document/content";

interface TreeCardButtonProps {
  borderColor: string;
  cardLabel?: string;
  contentJson: string;
  placeholder?: string;
  isActive?: boolean;
  isNeighborhood: boolean;
  onMeasureHeight?: (height: number) => void;
  onClick: () => void;
  cardWidth?: number;
  minHeight?: number;
  scale?: number;
  titleOnly?: boolean;
  x: number;
  y: number;
}

export function TreeCardButton({
  borderColor,
  cardLabel,
  contentJson,
  placeholder = "",
  isActive = false,
  isNeighborhood,
  onMeasureHeight,
  onClick,
  cardWidth,
  minHeight,
  scale = 1,
  titleOnly = false,
  x,
  y,
}: TreeCardButtonProps) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const horizontalPadding = titleOnly ? 20 : isActive ? 33 : 34;
  const topPadding = titleOnly ? 18 : isActive ? 40 : 42;
  const bottomPadding = titleOnly ? 18 : isActive ? 23 : 24;
  const renderedShadow = isActive
    ? "var(--fc-shadow-elevated)"
    : isNeighborhood
      ? "var(--fc-shadow-soft)"
      : "none";
  const renderedSurface = isActive
    ? "var(--fc-color-card-surface-active)"
    : "var(--fc-color-card-surface)";

  useLayoutEffect(() => {
    const buttonElement = buttonRef.current;

    if (!buttonElement || !onMeasureHeight) {
      return;
    }

    const measureHeight = () => {
      onMeasureHeight(
        Math.max(buttonElement.offsetHeight, buttonElement.scrollHeight),
      );
    };

    measureHeight();

    const observer = new ResizeObserver(() => {
      if (Math.max(buttonElement.offsetHeight, buttonElement.scrollHeight) > 0) {
        measureHeight();
      }
    });

    observer.observe(buttonElement);

    return () => {
      observer.disconnect();
    };
  }, [contentJson, onMeasureHeight]);

  return (
    <div
      className="absolute flex min-h-[var(--fc-card-height)] w-[var(--fc-card-width)] cursor-pointer flex-col justify-start border bg-[var(--fc-color-card-surface)] px-5 py-[10px] text-left transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
      onClick={onClick}
      ref={buttonRef}
      style={{
        borderColor: "transparent",
        borderWidth: "0px",
        boxShadow: renderedShadow,
        backgroundColor: renderedSurface,
        left: `calc(50% + ${x}px)`,
        minHeight: minHeight ? `${minHeight}px` : undefined,
        opacity: "1",
        paddingBottom: `${bottomPadding}px`,
        paddingLeft: `${horizontalPadding}px`,
        paddingRight: `${horizontalPadding}px`,
        paddingTop: `${topPadding}px`,
        top: `calc(50% + ${y}px)`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: "center",
        width: cardWidth ? `${cardWidth}px` : undefined,
        zIndex: isActive ? 2 : 1,
      } as CSSProperties}
    >
      {cardLabel ? (
        <p
          className="pointer-events-none absolute font-[var(--fc-font-ui)] text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--fc-color-card-label)]"
          style={{
            right: titleOnly ? "18px" : "28px",
            top: titleOnly ? "12px" : "18px",
          }}
        >
          {cardLabel}
        </p>
      ) : null}
      {titleOnly ? (
        <p
          className="m-0 max-w-full overflow-hidden pr-10 font-[var(--fc-font-ui)] text-[15px] font-semibold leading-[1.25] text-[var(--fc-color-text)]"
          style={{
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 2,
          }}
        >
          {contentTitlePreview(contentJson)}
        </p>
      ) : (
        <CardContentPreview contentJson={contentJson} placeholder={placeholder} />
      )}
    </div>
  );
}
