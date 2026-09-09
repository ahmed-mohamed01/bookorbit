/**
 * A Hardcover request that never produced an answer. `status` carries the HTTP status when the
 * response arrived and was rejected, and is null for a transport failure or a timeout, which have
 * none.
 *
 * Only calls that opt into surfacing failures raise this. The metadata providers deliberately treat
 * a failed request as "no candidate found", and turning that into a throw would break them; the
 * bibliography path cannot, because its callers decide whether to overwrite a stored catalog and
 * need an outage to be distinguishable from an author who genuinely has no books.
 */
export class HardcoverRequestError extends Error {
  constructor(
    readonly op: string,
    readonly status: number | null,
    options?: ErrorOptions,
  ) {
    super(`Hardcover request failed (op=${op}${status == null ? '' : `, status=${status}`})`, options);
    this.name = 'HardcoverRequestError';
  }
}

/**
 * Hardcover answered, and holds no author under the id asked for. Hardcover merges and removes
 * duplicate author records, so a stored id can stop resolving long after it was captured. Kept apart
 * from HardcoverRequestError because the two want opposite handling: an outage is worth retrying,
 * while a removed record will answer the same way forever.
 */
export class HardcoverAuthorGoneError extends Error {
  constructor(readonly authorId: number) {
    super(`Hardcover holds no author record for id ${authorId}`);
    this.name = 'HardcoverAuthorGoneError';
  }
}
