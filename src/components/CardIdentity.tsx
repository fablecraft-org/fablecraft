interface CardIdentityProps {
  cardLabel: string;
  descendantCount: number;
  compact?: boolean;
}

export function CardIdentity({ cardLabel, descendantCount, compact = false }: CardIdentityProps) {
  return (
    <p className={`fc-card-identity${compact ? " fc-card-identity-compact" : ""}`}>
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
