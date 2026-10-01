export const READ_ALONG_PROVENANCE_SOURCE = Symbol('READ_ALONG_PROVENANCE_SOURCE');

/** Which audiobook a read-along was generated from, when BookOrbit generated it. */
export interface ReadAlongProvenanceSource {
  findSourceAudioBookId(readAlongBookId: number): Promise<number | null>;
}
