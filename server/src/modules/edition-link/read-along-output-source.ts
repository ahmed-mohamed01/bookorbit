export const READ_ALONG_OUTPUT_SOURCE = Symbol('READ_ALONG_OUTPUT_SOURCE');

/**
 * Names the books that are generated read-alongs. Such a book stays one even after it is detached from
 * its pair, and must never become a side of an edition link.
 */
export interface ReadAlongOutputSource {
  findReadAlongOutputs(bookIds: readonly number[]): Promise<Set<number>>;
}
