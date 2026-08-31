import { describe, expect, it } from 'vitest';
import { blockedTargetReason } from './client.js';

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
