export const BOOK_REQUEST_AUTO_GRAB_SCHEMA_SQL = `ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "auto_grab" boolean;`;
