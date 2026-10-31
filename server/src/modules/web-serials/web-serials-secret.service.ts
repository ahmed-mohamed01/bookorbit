import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

import { webSerialsConfig } from './web-serials.config';

const ALGORITHM = 'aes-256-gcm';

// key = sha256(encryptionKey); stored as `v1:` + base64url IV, tag and ciphertext.
@Injectable()
export class WebSerialsSecretService {
  private readonly key: Buffer;

  constructor(@Inject(webSerialsConfig.KEY) config: ConfigType<typeof webSerialsConfig>) {
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
      throw new InternalServerErrorException('Web serials secret could not be decrypted');
    }
  }
}
