import { describe, expect, it } from 'vitest';

import { StorytellerSecretService } from './storyteller-secret.service';

function buildService(encryptionKey = 'test-encryption-key'): StorytellerSecretService {
  return new StorytellerSecretService({ encryptionKey, requestTimeoutMs: 30_000, transferTimeoutMs: 120 * 60_000, waitCeilingMs: 720 * 60_000 });
}

describe('StorytellerSecretService', () => {
  it('round-trips a value through encrypt and decrypt', () => {
    const service = buildService();
    const original = 'super-secret-password';

    const encrypted = service.encrypt(original);

    expect(encrypted).not.toBe(original);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(service.decrypt(encrypted)).toBe(original);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const service = buildService();
    const original = 'same-password';

    const first = service.encrypt(original);
    const second = service.encrypt(original);

    expect(first).not.toBe(second);
    expect(service.decrypt(first)).toBe(original);
    expect(service.decrypt(second)).toBe(original);
  });

  it('throws when the ciphertext is tampered with', () => {
    const service = buildService();
    const encrypted = service.encrypt('tamper-me');
    const [version, iv, tag, ciphertext] = encrypted.split(':');
    const buf = Buffer.from(ciphertext!, 'base64url');
    buf[buf.length - 1] ^= 1;
    const tampered = `${version}:${iv}:${tag}:${buf.toString('base64url')}`;

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('throws when the auth tag is tampered with', () => {
    const service = buildService();
    const encrypted = service.encrypt('tamper-me');
    const [version, iv, tag, ciphertext] = encrypted.split(':');
    const buf = Buffer.from(tag!, 'base64url');
    buf[0] ^= 1;
    const tampered = `${version}:${iv}:${buf.toString('base64url')}:${ciphertext}`;

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('throws on a malformed value', () => {
    const service = buildService();

    expect(() => service.decrypt('not-a-valid-value')).toThrow();
    expect(() => service.decrypt('v2:a:b:c')).toThrow();
  });

  it('cannot decrypt a value encrypted with a different key', () => {
    const first = buildService('key-one');
    const second = buildService('key-two');
    const encrypted = first.encrypt('cross-key-secret');

    expect(() => second.decrypt(encrypted)).toThrow();
  });
});
