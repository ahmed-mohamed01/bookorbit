/**
 * The one way this module derives the `errorClass=...` field of a `[fail]` line. The message comes
 * back raw: callers pass it through `sanitizeLogValue` at the log site, and the build service also
 * persists it verbatim as the build's error.
 */
export function describeError(error: unknown): { errorClass: string; message: string } {
  if (error instanceof Error) return { errorClass: error.constructor.name, message: error.message };
  return { errorClass: 'UnknownError', message: String(error) };
}
