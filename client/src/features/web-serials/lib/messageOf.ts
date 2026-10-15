import { ApiError, errorMessage } from '@/lib/api-json'

/** A Book Requests refusal whose text is already the one to show, coded or not, as the Requests page shows it. */
export class RequestRefusal extends ApiError {}

/** The text for a failed action: a coded server answer or a client error speaks for itself, otherwise `fallbackKey` does. */
export function messageOf(error: unknown, fallbackKey: string): string {
  if (error instanceof RequestRefusal) return error.message
  return errorMessage(error, fallbackKey)
}
