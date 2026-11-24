import { useId, useState, type MouseEvent } from "react";
import type { PassageEntry } from "../domain/document/manuscript";

export function ManuscriptBacklinks({ entries, onReveal, onRemove, compact = false }: {
  entries: PassageEntry[];
  onReveal: (entry: PassageEntry) => void;
  onRemove?: (entry: PassageEntry) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const overflowId = useId();
  if (!entries.length) return null;
  const stop = (event: MouseEvent) => event.stopPropagation();
  function links(rows: PassageEntry[]) {
    return rows.map((entry) => (
      <div className="fc-manuscript-backlink-row" key={entry.id}>
        <button type="button"
          aria-label={`Reveal manuscript passage ${entry.lines} ${entry.excerpt}`}
          onClick={() => onReveal(entry)}>{entry.lines} · {entry.excerpt}</button>
        {onRemove && <button type="button" className="fc-manuscript-backlink-remove"
          aria-label={`Remove manuscript link ${entry.lines} ${entry.excerpt}`}
          onClick={() => onRemove(entry)}>×</button>}
      </div>
    ));
  }
  const visible = compact ? 0 : Math.min(entries.length, 3);
  return (
    <footer className={`fc-manuscript-backlinks${compact ? " is-compact" : ""}`}
      onClick={stop} onDoubleClick={stop} aria-label="Manuscript backlinks">
      {links(entries.slice(0, visible))}
      {entries.length > visible && (
        <>
          <button type="button" className="fc-manuscript-overflow"
            onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={overflowId}
            aria-label={`${entries.length - visible} ${compact ? "linked manuscript passages" : "more manuscript passages"}`}>
            {compact ? `${entries.length} ↗` : `${entries.length - visible} more`}
          </button>
          <div id={overflowId} className="fc-manuscript-overflow-list" hidden={!open}>
            {open && links(entries.slice(visible))}
          </div>
        </>
      )}
    </footer>
  );
}
