import { InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { WebSerialsSecretService } from './web-serials-secret.service';

const build = (encryptionKey = 'test-encryption-key') => new WebSerialsSecretService({ encryptionKey });

describe('WebSerialsSecretService', () => {
  it('round-trips a value', () => {
    const service = build();
    const encrypted = service.encrypt('hunter2');

    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('hunter2');
    expect(service.decrypt(encrypted)).toBe('hunter2');
  });

  it('uses a fresh IV per encryption', () => {
    const service = build();

    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('cannot decrypt with a different key or a malformed payload', () => {
    const encrypted = build('key-a').encrypt('secret');

    expect(() => build('key-b').decrypt(encrypted)).toThrow(InternalServerErrorException);
    expect(() => build().decrypt('garbage')).toThrow(InternalServerErrorException);
    expect(() => build().decrypt('v2:a:b:c')).toThrow(InternalServerErrorException);
  });
});
