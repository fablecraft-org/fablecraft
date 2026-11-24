import type { DocumentSummary } from "../../types/document";

export interface CardRecord {
  documentId: string;
  id: string;
  orderIndex: number;
  parentId: string | null;
  type: "card";
}

export interface CardContentRecord {
  cardId: string;
  contentJson: string;
}

export interface RevisionRecord {
  createdAtMs: number;
  id: string;
  sequence?: number;
  snapshot?: string;
}

export interface ManuscriptPassage {
  id: string;
  from: number;
  to: number;
  targetCardIds: string[];
}

export interface Manuscript {
  id: string;
  contentJson: string;
  passages: ManuscriptPassage[];
}

export interface DocumentSnapshot {
  cards: CardRecord[];
  contents: CardContentRecord[];
  manuscript?: Manuscript | null;
  revisions: RevisionRecord[];
  summary: DocumentSummary;
}

export interface EditableDocumentSnapshot {
  cards: CardRecord[];
  contents: CardContentRecord[];
  documentId: string;
  manuscript?: Manuscript | null;
  baseRevisionId?: string | null;
  manuscriptAware?: boolean;
}

export interface SaveDocumentResult {
  revisionId: string;
  savedAtMs: number;
}
