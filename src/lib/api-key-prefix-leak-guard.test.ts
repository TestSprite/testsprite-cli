import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { API_KEY_PREFIXES } from './client-factory.js';

/**
 * Drift guard between "what counts as a TestSprite API key" and "what our
 * release-time leak scans can see".
 *
 * The 2026-08-01 rename to `sk-member-` made every newly minted key invisible
 * to all three detectors at once — `.gitleaks.toml` had no provider rule at
 * all, and both LEAK_RE greps enumerated `sk-user-` only. A leak of the
 * CURRENT credential would have passed the public-export gate. After an
 * incident that put 452 live keys in 499 public repositories, that is the
 * failure that only surfaces the next time.
 *
 * So: every prefix the CLI accepts must be a prefix the scans detect, checked
 * mechanically rather than remembered.
 */

/**
 * Realistic tokens for `prefix` — 43 base64url chars, what both mint paths
 * emit. `tsp_` is a NAMESPACE, not a token prefix: the format gate accepts any
 * `tsp_`-prefixed value, and `tsp_sa_` is reserved for phase-2 service-account
 * keys. Probing only `tsp_u_` would let a scan that pins `u_` pass while the
 * CLI happily accepts a `tsp_sa_` credential no detector can see — the exact
 * failure this file exists to prevent, one level down. Add a kind here in the
 * same change that starts minting it.
 */
const TSP_KINDS = ['u', 'sa'] as const;
const samples = (prefix: string): string[] =>
  prefix === 'tsp_'
    ? TSP_KINDS.map(k => `${prefix}${k}_${'A'.repeat(43)}`)
    : [`${prefix}${'A'.repeat(43)}`];

describe('API key prefixes are covered by the release leak scans', () => {
  it('every accepted prefix is matched by a .gitleaks.toml rule', () => {
    const toml = readFileSync('.gitleaks.toml', 'utf8');
    // Crude but sufficient: pull every `regex = '''…'''` out of the rule
    // blocks. A structured TOML parse would need a new dependency for one
    // assertion, and the failure mode we care about (a prefix nobody added)
    // shows up identically either way.
    const regexes: string[] = [...toml.matchAll(/^regex\s*=\s*'''(.*)'''\s*$/gm)].map(
      m => m[1] as string,
    );
    expect(regexes.length).toBeGreaterThan(0);
    for (const prefix of API_KEY_PREFIXES) {
      for (const token of samples(prefix)) {
        const covered = regexes.some(r => new RegExp(r).test(token));
        expect(covered, `no gitleaks rule detects "${token.slice(0, 12)}…"`).toBe(true);
      }
    }
  });

  it('every accepted prefix is DETECTED by the copybara leak-safety LEAK_RE', () => {
    // `scripts/make-public-snapshot.sh` carries the same patterns but is DROPped
    // from the public snapshot, so it cannot be asserted from a shipped test.
    // `copybara/leak-safety-harness.sh` ships, and the two are kept in sync by
    // hand — if you edit one, edit both.
    //
    // This used to assert only that the `sk-` families were *enumerated*, and
    // skipped `tsp_` on the reasoning that "gitleaks covers it". A post-merge
    // audit showed that reasoning is wrong where it matters: the snapshot
    // script treats gitleaks as optional-skip-not-fail, so on a local
    // break-glass run LEAK_RE is the ONLY detector — and it never matched a
    // `tsp_` token. So the assertion is now behavioural: build a realistic
    // token for every accepted prefix and require the actual pattern to match
    // it. Enumeration was a proxy; detection is the property.
    const path = 'copybara/leak-safety-harness.sh';
    if (!existsSync(path)) return;
    const sh = readFileSync(path, 'utf8');
    const patterns = [...sh.matchAll(/^[A-Z_]*LEAK_RE='([^']+)'/gm)].map(m => m[1] as string);
    expect(patterns.length).toBeGreaterThan(0);
    for (const prefix of API_KEY_PREFIXES) {
      for (const token of samples(prefix)) {
        for (const pattern of patterns) {
          expect(
            new RegExp(pattern).test(token),
            `a LEAK_RE does not detect "${token.slice(0, 14)}…"`,
          ).toBe(true);
        }
      }
    }
  });
});
