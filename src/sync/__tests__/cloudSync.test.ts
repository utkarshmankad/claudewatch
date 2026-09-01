import { createDecipheriv } from 'crypto';
import { describe, expect, it } from 'vitest';
import { decryptSyncPayload, encryptSyncPayload } from '../cloudSync.js';

describe('cloud sync encryption', () => {
  it('encrypts without leaking plaintext fields', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const envelope = encryptSyncPayload({ provider: 'claude', tokens: 42 }, key);
    expect(JSON.stringify(envelope)).not.toContain('claude');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const value = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    expect(JSON.parse(value)).toEqual({ provider: 'claude', tokens: 42 });
    expect(decryptSyncPayload(envelope, key)).toEqual({ provider: 'claude', tokens: 42 });
  });
});
