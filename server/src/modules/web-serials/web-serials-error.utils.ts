import type { WebSerialErrorCode } from '@bookorbit/types';

export interface WebSerialErrorBody {
  message: string;
  errorCode: WebSerialErrorCode;
  errorMeta?: Record<string, string | number>;
}

/** The body of an HttpException the client can translate: the English `message` stays for logs. */
export function codedError(message: string, errorCode: WebSerialErrorCode, errorMeta?: Record<string, string | number>): WebSerialErrorBody {
  return errorMeta ? { message, errorCode, errorMeta } : { message, errorCode };
}
