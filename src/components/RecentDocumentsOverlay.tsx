import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fileStem } from "../storage/filePaths";
import { OverlayShell } from "./OverlayShell";

interface RecentDocumentsOverlayProps {
  onClose: () => void;
  onOpenDocument: (path: string) => void;
  recentDocumentPaths: string[];
}

export function RecentDocumentsOverlay({
  onClose,
  onOpenDocument,
  recentDocumentPaths,
}: RecentDocumentsOverlayProps) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const visiblePaths = recentDocumentPaths.slice(0, 5);

  useEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, visiblePaths.length);
    const activeRow = rowRefs.current[selectedIndex] ?? rowRefs.current[0];

    if (!activeRow) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      activeRow.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [selectedIndex, visiblePaths.length]);

  useEffect(() => {
    setSelectedIndex((currentIndex) =>
      visiblePaths.length === 0 ? 0 : Math.min(currentIndex, visiblePaths.length - 1),
    );
  }, [visiblePaths.length]);

  function moveSelection(direction: -1 | 1) {
    if (visiblePaths.length === 0) {
      return;
    }

    setSelectedIndex(
      (currentIndex) => (currentIndex + direction + visiblePaths.length) % visiblePaths.length,
    );
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, path: string) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenDocument(path);
    }
  }

  return (
    <OverlayShell
      footer="Escape closes recent documents."
      onBackdropMouseDown={onClose}
      title="Open Recent"
      widthClassName="max-w-[min(92vw,620px)]"
    >
      {visiblePaths.length === 0 ? (
        <p className="px-1 py-3 text-sm text-[var(--fc-color-muted)]">
          No recent documents yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visiblePaths.map((path, index) => {
            const isActive = index === selectedIndex;

            return (
              <button
                className="px-4 py-3 text-left outline-none transition duration-[var(--fc-animation-ms)] ease-[var(--fc-animation-easing)]"
                key={path}
                onClick={() => onOpenDocument(path)}
                onFocus={() => setSelectedIndex(index)}
                onKeyDown={(event) => handleKeyDown(event, path)}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                style={{
                  backgroundColor: isActive
                    ? "var(--fc-color-surface-strong)"
                    : "var(--fc-color-surface)",
                  boxShadow: isActive ? "var(--fc-shadow-soft)" : "none",
                }}
                type="button"
              >
                <p className="font-[var(--fc-font-ui)] text-base text-[var(--fc-color-text)]">
                  {fileStem(path)}
                </p>
                <p className="mt-1 truncate font-[var(--fc-font-ui)] text-xs text-[var(--fc-color-muted)]">
                  {path}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </OverlayShell>
  );
}
