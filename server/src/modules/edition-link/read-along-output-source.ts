export const READ_ALONG_OUTPUT_SOURCE = Symbol('READ_ALONG_OUTPUT_SOURCE');

/**
 * Names the books that are generated read-alongs. Such a book stays one even after it is detached from
 * its pair, and must never become a side of an edition link.
 */
export interface ReadAlongOutputSource {
  findReadAlongOutputs(bookIds: readonly number[]): Promise<Set<number>>;
  /** The text/audio pair a read-along was generated from, which it stays matched to once detached. */
  findSourcePair(readAlongBookId: number): Promise<ReadAlongSourcePair | null>;
  /** The build that generated this book, or null when no build did. */
  findBuildByReadAlong(readAlongBookId: number): Promise<ReadAlongBuildRef | null>;
  /** The newest build of any status but cancelled for this ebook, which the ebook page may propose. */
  findNewestBuildForText(textBookId: number): Promise<ReadAlongBuildProposal | null>;
  /** The newest build of any status but cancelled for this audiobook, which the audiobook page may propose. */
  findNewestBuildForAudio(audioBookId: number): Promise<ReadAlongBuildProposal | null>;
  /**
   * The read-along generated for this link's pair when the link lost it, as an unlink and relink
   * leaves it. Null when there is none, or when it was detached from this same link on purpose.
   */
  findLostReadAlong(link: ReadAlongLinkTarget): Promise<ReadAlongAttachment | null>;
  /** Records that the build's read-along now sits on the link, so a later detach there stays a detach. */
  recordAttachment(buildId: number, linkId: number): Promise<void>;
  /**
   * Records, on the build that generated this read-along, that it was detached from the link on
   * purpose, so a later heal leaves it detached. A book no build generated has nothing to record.
   */
  recordDetach(readAlongBookId: number, linkId: number): Promise<void>;
}

export interface ReadAlongSourcePair {
  textBookId: number;
  audioBookId: number;
}

export interface ReadAlongLinkTarget {
  id: number;
  textBookId: number | null;
  audioBookId: number;
  readAlongBookId: number | null;
}

/** The build that generated a read-along book, looked up by that book. */
export interface ReadAlongBuildRef extends ReadAlongAttachment {
  textBookId: number;
  audioBookId: number;
}

/** A generated read-along and the build that produced it, as it is put on a link. */
export interface ReadAlongAttachment {
  buildId: number;
  outputBookId: number;
}

/** A build as a page weighs it for a proposal: its pair, how far it got, and the book it produced. */
export interface ReadAlongBuildProposal extends ReadAlongSourcePair {
  status: string;
  outputBookId: number | null;
}
