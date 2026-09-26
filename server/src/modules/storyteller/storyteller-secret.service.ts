import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

import { storytellerConfig } from './storyteller.config';

const ALGORITHM = 'aes-256-gcm';

// AES-256-GCM encryption for the Storyteller service-account password, mirroring
// PodcastSecretService: key = sha256(config.encryptionKey), IV 12 bytes + tag 16 bytes + ciphertext,
// each base64url-encoded and colon-separated behind a version prefix so the format can change later.
@Injectable()
export class StorytellerSecretService {
  private readonly key: Buffer;

  constructor(@Inject(storytellerConfig.KEY) config: ConfigType<typeof storytellerConfig>) {
    this.key = createHash('sha256').update(config.encryptionKey, 'utf8').digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  decrypt(value: string): string {
    try {
      const [version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split(':');
      if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) throw new InternalServerErrorException();
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivEncoded, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('Storyteller secret could not be decrypted');
    }
  }
}
