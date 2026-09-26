// Serialized edition-link contract shared by the server API and the client. `createdBy` is nullable
// (the creator may be deleted - the FK is ON DELETE SET NULL), and `createdAt` is an ISO string over
// the wire. Both sides consume THIS type so `tsc` catches any drift between them.
export interface EditionLink {
  id: number;
  textBookId: number;
  audioBookId: number;
  readAlongBookId: number | null;
  createdBy: number | null;
  createdAt: string;
}

// Which member of the link the requested book is. Null when the book is not part of a link the
// requester may see.
export type EditionLinkRole = 'text' | 'audio' | 'readAlong';

export interface EditionLinkMemberProgress {
  percentage: number;
  updatedAt: string;
}

// `narrationPercentage` only ever applies to the read-along member: EPUB3 narration keeps its own
// progress beside the text position, so both are surfaced for that row.
export interface EditionLinkMember {
  id: number;
  title: string | null;
  authorName: string | null;
  progress: EditionLinkMemberProgress | null;
  narrationPercentage: number | null;
}

export interface EditionLinkMembers {
  text: EditionLinkMember;
  audio: EditionLinkMember;
  readAlong: EditionLinkMember | null;
}

export interface EditionLinkCandidate {
  bookId: number;
  title: string | null;
  authorName: string | null;
  score: number;
}

// Display-only summary of the book on the other side of a link. Resolved server-side so the client
// never has to fetch the counterpart's full book detail (files, metadata, series) just to show a title
// and author.
export interface EditionLinkCounterpartSummary {
  id: number;
  title: string | null;
  authorName: string | null;
}

export interface EditionLinkForBook {
  link: EditionLink | null;
  proposed: EditionLinkCandidate | null;
  counterpart: EditionLinkCounterpartSummary | null;
  role: EditionLinkRole | null;
  members: EditionLinkMembers | null;
}
