/** The one way this module derives the `errorClass=...` field of a `[fail]` log line. */
export function describeError(error: unknown): { errorClass: string; message: string } {
  if (error instanceof Error) return { errorClass: error.constructor.name, message: error.message };
  return { errorClass: 'UnknownError', message: String(error) };
}
