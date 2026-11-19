interface CardIdentityProps {
  cardLabel: string;
  descendantCount: number;
  compact?: boolean;
  isReference?: boolean;
}

export function CardIdentity({ cardLabel, descendantCount, compact = false, isReference = false }: CardIdentityProps) {
  return (
    <p className={`fc-card-identity${compact ? " fc-card-identity-compact" : ""}`}>
      {isReference ? <svg className="fc-reference-icon" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        role="img" aria-label="Reference to a card elsewhere">
        <path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2" />
        <path d="M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2" />
      </svg> : null}
      {descendantCount > 0 ? <span
        className="fc-descendant-count"
        aria-label={`${descendantCount} descendant ${descendantCount === 1 ? "card" : "cards"}`}
        title={`${descendantCount} descendant ${descendantCount === 1 ? "card" : "cards"}`}
      >
        {descendantCount}
      </span> : null}
      <span>{cardLabel}</span>
    </p>
  );
}
