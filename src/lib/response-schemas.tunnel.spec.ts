import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { TUNNEL_MINT_RESPONSE_SCHEMA } from './response-schemas.js';

const VALID_MINT = {
  clientId: '11111111-2222-3333-4444-555555555555',
  secret: '99999999-8888-7777-6666-555555555555',
  controlUrl: 'ws://tunnel.example:7300/ws',
  tunnelAddr: 'tunnel.example:7400',
  expiresAt: '2026-08-24T18:00:00.000Z',
};

describe('TUNNEL_MINT_RESPONSE_SCHEMA', () => {
  it('accepts an old-backend response without tunnelTlsAddr', () => {
    const parsed = v.safeParse(TUNNEL_MINT_RESPONSE_SCHEMA, VALID_MINT);

    expect(parsed.success).toBe(true);
  });

  it('accepts and preserves tunnelTlsAddr when the backend advertises it', () => {
    const parsed = v.safeParse(TUNNEL_MINT_RESPONSE_SCHEMA, {
      ...VALID_MINT,
      tunnelTlsAddr: 'data.tun.testsprite.com:443',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.tunnelTlsAddr).toBe('data.tun.testsprite.com:443');
    }
  });

  it('rejects an empty tunnelTlsAddr instead of silently selecting plaintext', () => {
    const parsed = v.safeParse(TUNNEL_MINT_RESPONSE_SCHEMA, {
      ...VALID_MINT,
      tunnelTlsAddr: '',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map(issue => v.getDotPath(issue))).toContain('tunnelTlsAddr');
    }
  });

  it.each(['clientId', 'secret', 'controlUrl', 'tunnelAddr'] as const)(
    'rejects an empty %s',
    field => {
      const parsed = v.safeParse(TUNNEL_MINT_RESPONSE_SCHEMA, {
        ...VALID_MINT,
        [field]: '',
      });

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.issues.some(issue => v.getDotPath(issue) === field)).toBe(true);
      }
    },
  );
});
