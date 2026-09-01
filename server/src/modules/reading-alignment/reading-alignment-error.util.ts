// Shared shape for the module's catch-site logging: a stable errorClass plus a plain message,
// whatever was thrown.
export function describeError(error: unknown): { errorClass: string; message: string } {
  if (error instanceof Error) return { errorClass: error.constructor.name, message: error.message };
  return { errorClass: 'Error', message: String(error) };
}
