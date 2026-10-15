import { registerAs } from '@nestjs/config';

export const webSerialsConfig = registerAs('webSerials', () => ({
  encryptionKey: process.env.WEB_SERIALS_ENCRYPTION_KEY?.trim() || process.env.JWT_SECRET || 'change-me-in-production',
}));
