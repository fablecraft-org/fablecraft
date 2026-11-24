import { pruneManuscriptTargets } from "./manuscript";
import { normalizeCardLinkLabels } from "./cardLinks";
import type { CardContentRecord, CardRecord, DocumentSnapshot, EditableDocumentSnapshot, RevisionRecord } from "./types";
import { normalizePassageAnchors } from "./passageAnchors";

function compareNullableStrings(left: string | null, right: string | null) {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return -1;
  }

  if (right === null) {
    return 1;
  }

  return left.localeCompare(right);
}

function normalizeCards(cards: CardRecord[]) {
  return [...cards].sort((left, right) => {
    const parentComparison = compareNullableStrings(left.parentId, right.parentId);

    if (parentComparison !== 0) {
      return parentComparison;
    }

    if (left.orderIndex !== right.orderIndex) {
      return left.orderIndex - right.orderIndex;
    }

    return left.id.localeCompare(right.id);
  });
}

function normalizeContents(contents: CardContentRecord[]) {
  return [...contents].sort((left, right) => left.cardId.localeCompare(right.cardId));
}

function normalizeRevisions(revisions: RevisionRecord[]) {
  return [...revisions].sort((left, right) => right.createdAtMs - left.createdAtMs ||
    (left.sequence !== undefined && right.sequence !== undefined ? right.sequence - left.sequence : 0));
}

export function normalizeEditableDocumentSnapshot(
  snapshot: EditableDocumentSnapshot,
): EditableDocumentSnapshot {
  return {
    cards: normalizeCards(snapshot.cards),
    contents: normalizeContents(normalizeCardLinkLabels(snapshot.cards, normalizePassageAnchors(snapshot.cards, snapshot.contents))),
    documentId: snapshot.documentId,
    ...(snapshot.manuscript ? { manuscript: pruneManuscriptTargets(snapshot.manuscript, snapshot.cards) } : {}),
  };
}

export function normalizeDocumentSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  return {
    cards: normalizeCards(snapshot.cards),
    contents: normalizeContents(normalizeCardLinkLabels(snapshot.cards, normalizePassageAnchors(snapshot.cards, snapshot.contents))),
    ...(snapshot.manuscript ? { manuscript: pruneManuscriptTargets(snapshot.manuscript, snapshot.cards) } : {}),
    revisions: normalizeRevisions(snapshot.revisions),
    summary: snapshot.summary,
  };
}

function comparableDocumentSummary(snapshot: DocumentSnapshot) {
  return {
    documentId: snapshot.summary.documentId,
    name: snapshot.summary.name,
    openedAtMs: 0,
    path: snapshot.summary.path,
  };
}

export function latestRevisionId(snapshot: DocumentSnapshot) {
  return normalizeRevisions(snapshot.revisions)[0]?.id ?? null;
}

export function toEditableDocumentSnapshot(
  snapshot: DocumentSnapshot,
): EditableDocumentSnapshot {
  return {
    ...normalizeEditableDocumentSnapshot({
      cards: snapshot.cards,
      contents: snapshot.contents,
      documentId: snapshot.summary.documentId,
      manuscript: snapshot.manuscript,
    }),
    baseRevisionId: latestRevisionId(snapshot),
    manuscriptAware: true,
  };
}

export function serializeEditableDocumentSnapshot(
  snapshot: EditableDocumentSnapshot,
) {
  return JSON.stringify(normalizeEditableDocumentSnapshot(snapshot));
}

export function serializeDocumentSnapshot(snapshot: DocumentSnapshot) {
  return JSON.stringify(normalizeDocumentSnapshot(snapshot));
}

export function serializeDocumentRevisionSnapshot(snapshot: DocumentSnapshot) {
  return serializeEditableDocumentSnapshot(toEditableDocumentSnapshot(snapshot));
}

export function serializeComparableDocumentSnapshot(snapshot: DocumentSnapshot) {
  const normalizedSnapshot = normalizeDocumentSnapshot(snapshot);

  return JSON.stringify({
    cards: normalizedSnapshot.cards,
    contents: normalizedSnapshot.contents,
    manuscript: normalizedSnapshot.manuscript,
    summary: comparableDocumentSummary(normalizedSnapshot),
  });
}
