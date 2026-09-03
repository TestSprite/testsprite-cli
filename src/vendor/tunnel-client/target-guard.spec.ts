import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BlockedTargetError, blockedTargetReason } from './client.js';

const EMBEDDED_IPV4_REASON = 'IPv4 address embedded in an IPv6 literal';

describe('blockedTargetReason', () => {
  it.each([
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:a00:1',
    '::ffff:0:7f00:1',
    '::ffff:0:0:a9fe:a9fe',
    '::0:ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    // Non-canonical NAT64 prefix — in neither RFC 6052's `64:ff9b::/96` nor RFC 8215's
    // `64:ff9b:1::/48`, but inside the `64:ff9b::/32` superset (VENDOR.md #11).
    '64:ff9b:ffff::a9fe:a9fe',
    // Outside the old `::/96` IPv4-compatible check, but inside the `::/32` superset
    // (VENDOR.md #11).
    '::1:2:3:4:5:6',
    '2002:a9fe:a9fe::',
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
  ])('refuses embedded IPv4 literal %s', address => {
    expect(blockedTargetReason(address)).toBe(EMBEDDED_IPV4_REASON);
  });

  it('refuses the deprecated IPv6 site-local range', () => {
    expect(blockedTargetReason('fec0::1')).toBe('IPv6 site-local address');
  });

  it.each(['::ffff:169.254.169.254', '::ffff:10.0.0.1'])(
    'keeps refusing mapped private IPv4 literal %s',
    address => {
      expect(blockedTargetReason(address)).toBeDefined();
    },
  );

  it.each([
    '::1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2001:db8::a9fe:a9fe',
    '2001:db8::1',
    '8.8.8.8',
    '2606:4700:4700::1111',
  ])('allows loopback or public literal %s', address => {
    expect(blockedTargetReason(address)).toBeUndefined();
  });

  it.each([
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
  ])('keeps refusing IPv4 literal %s', address => {
    expect(blockedTargetReason(address)).toBeDefined();
  });

  it.each(['8.8.8.8', '127.0.0.1'])('keeps allowing IPv4 literal %s', address => {
    expect(blockedTargetReason(address)).toBeUndefined();
  });

  it('gives every spelling of one address the same verdict', () => {
    const spellings = [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::0:ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '0000:0000:0000:0000:0000:ffff:a9fe:a9fe',
    ];
    const canonicalRefused = blockedTargetReason('::ffff:169.254.169.254') !== undefined;

    expect(canonicalRefused).toBe(true);
    expect(
      spellings.every(address => (blockedTargetReason(address) !== undefined) === canonicalRefused),
    ).toBe(true);
  });
});

describe('BlockedTargetError guidance', () => {
  it('states the reachable target policy without naming a nonexistent override', () => {
    const error = new BlockedTargetError(
      'dependency.internal',
      443,
      '10.0.0.8',
      'private IPv4 address',
    );

    expect(error.message).toBe(
      'target dependency.internal:443 resolves to 10.0.0.8 (private IPv4 address); refusing to dial. ' +
        'This run can reach localhost, 127.0.0.1, or ::1 on this machine and the public internet; ' +
        'private/LAN/VPN addresses are deliberately blocked. Make the dependency reachable through ' +
        'loopback or a public address, then retry.',
    );
    expect(error.message).not.toContain('TS_TUNNEL_ALLOW_PRIVATE_NETWORK_TARGET');
  });

  it('has no executable CLI source reference to the unused environment variable', () => {
    const references: string[] = [];
    for (const file of productionTypeScriptFiles(resolve('src'))) {
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- `file` comes from walking this repository's own `src` tree below, never from input
        readFileSync(file, 'utf8'),
      );
      while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        if (scanner.getTokenText().includes('TS_TUNNEL_ALLOW_PRIVATE_NETWORK_TARGET')) {
          references.push(file);
        }
      }
    }

    expect(references).toEqual([]);
  });
});

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `directory` starts at resolve('src') and only ever descends into directories found there
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(path));
    } else if (
      entry.isFile() &&
      path.endsWith('.ts') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.spec.ts') &&
      !path.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}
