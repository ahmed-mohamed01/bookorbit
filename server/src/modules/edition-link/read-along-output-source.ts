export const READ_ALONG_OUTPUT_SOURCE = Symbol('READ_ALONG_OUTPUT_SOURCE');

/**
 * Names the books that are generated read-alongs. Such a book stays one even after it is detached from
 * its pair, and must never become a side of an edition link.
 */
export interface ReadAlongOutputSource {
  findReadAlongOutputs(bookIds: readonly number[]): Promise<Set<number>>;
  /** The text/audio pair a read-along was generated from, which it stays matched to once detached. */
  findSourcePair(readAlongBookId: number): Promise<ReadAlongSourcePair | null>;
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

export interface ReadAlongLinkTarget extends ReadAlongSourcePair {
  id: number;
  readAlongBookId: number | null;
}

/** A generated read-along and the build that produced it, as it is put on a link. */
export interface ReadAlongAttachment {
  buildId: number;
  outputBookId: number;
}
