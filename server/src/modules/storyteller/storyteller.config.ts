import { registerAs } from '@nestjs/config';

// Module-owned: registered via ConfigModule.forFeature, so the integration stays removable without
// touching config/config.ts.
export const storytellerConfig = registerAs('storyteller', () => ({
  encryptionKey: process.env.STORYTELLER_ENCRYPTION_KEY?.trim() || process.env.JWT_SECRET || 'change-me-in-production',
  requestTimeoutMs: parsePositiveInteger(process.env.STORYTELLER_REQUEST_TIMEOUT_MS, 30_000),
  // Uploads and downloads move whole audiobooks, so they get a longer ceiling than an API call.
  transferTimeoutMs: parsePositiveInteger(process.env.STORYTELLER_TRANSFER_TIMEOUT_MINUTES, 120) * 60_000,
  // Hard ceiling on how long a build waits for Storyteller to finish aligning before giving up.
  waitCeilingMs: parsePositiveInteger(process.env.STORYTELLER_WAIT_CEILING_MINUTES, 720) * 60_000,
}));

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}
