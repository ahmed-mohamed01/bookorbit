// Serialized edition-link contract shared by the server API and the client. `createdBy` is nullable
// (the creator may be deleted - the FK is ON DELETE SET NULL), and `createdAt` is an ISO string over
// the wire. Both sides consume THIS type so `tsc` catches any drift between them.
export interface EditionLink {
  id: number;
  textBookId: number;
  audioBookId: number;
  createdBy: number | null;
  createdAt: string;
}

export interface EditionLinkCandidate {
  bookId: number;
  title: string | null;
  authorName: string | null;
  score: number;
}

export interface EditionLinkForBook {
  link: EditionLink | null;
  proposed: EditionLinkCandidate | null;
}
