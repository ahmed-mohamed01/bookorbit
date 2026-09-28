export const READ_ALONG_LINK_SOURCE = Symbol('READ_ALONG_LINK_SOURCE');

export interface ReadAlongLink {
  audioBookId: number;
  readAlongBookId: number;
}

export interface ReadAlongLinkSource {
  findReadAlongLink(bookId: number): Promise<ReadAlongLink | null>;
}
