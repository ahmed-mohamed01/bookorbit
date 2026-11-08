import type { FastifyReply } from 'fastify';
import { IMMUTABLE_CACHE_CONTROL } from './static-cache.utils';

const REVALIDATE_CACHE_CONTROL = 'no-cache';

export function sendImageConditional(reply: FastifyReply, options: { mtimeMs: number; versioned: boolean; ifNoneMatch?: string }): boolean {
  const etag = `"${Math.floor(options.mtimeMs)}"`;
  reply.header('Cache-Control', options.versioned ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL);
  reply.header('ETag', etag);
  if (options.ifNoneMatch !== etag) return false;
  reply.status(304).send();
  return true;
}
