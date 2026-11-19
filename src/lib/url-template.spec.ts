import { describe, expect, it } from 'vitest';
import {
  branchSlug,
  missingPlaceholders,
  renderUrlTemplate,
  unsafeHostPlaceholders,
  validateUrlTemplate,
} from './url-template.js';

// The GitHub App's own cases (backend `trigger-url.util.spec.ts`), kept
// verbatim: a pattern copied between the Portal and a workflow must render the
// same URL on both sides.
describe('renderUrlTemplate — the App cases', () => {
  it('renders {branch-slug} vercel-style', () => {
    expect(
      renderUrlTemplate('https://gym-web-git-{branch-slug}-sherrys-projects.vercel.app', {
        branch: 'feat/Login_v2',
      }),
    ).toBe('https://gym-web-git-feat-login-v2-sherrys-projects.vercel.app');
  });

  it('renders {pr}, {pr-number}, {branch}, {sha}, {short-sha}', () => {
    expect(
      renderUrlTemplate('https://pr-{pr}.x.com/{branch}/{sha}/{short-sha}', {
        pr: 110,
        branch: 'dev',
        sha: 'abcdef1234567890',
      }),
    ).toBe('https://pr-110.x.com/dev/abcdef1234567890/abcdef1');
    expect(renderUrlTemplate('https://pr-{pr-number}.x.com', { pr: 42 })).toBe(
      'https://pr-42.x.com',
    );
  });

  it('returns null when a referenced variable is missing from the context', () => {
    expect(renderUrlTemplate('https://pr-{pr}.x.com', { pr: null })).toBeNull();
    expect(renderUrlTemplate('https://{branch}.x.com', { pr: 1 })).toBeNull();
  });

  it('leaves templates without placeholders intact', () => {
    expect(renderUrlTemplate('https://static.example.com', {})).toBe('https://static.example.com');
  });

  it('ignores unknown placeholder-like text', () => {
    expect(renderUrlTemplate('https://x.com/{unknown}', { pr: 1 })).toBe('https://x.com/{unknown}');
  });
});

// The platform shapes the flag exists for, with the branch names that show up
// in practice. Each row is (template, vars, expected).
describe('renderUrlTemplate — platform shapes', () => {
  const SHA = '7e1d0ca9b2f14c3d5e6f708192a3b4c5d6e7f809';
  const rows: Array<[string, Parameters<typeof renderUrlTemplate>[1], string]> = [
    // Vercel branch alias: <project>-git-<branch-slug>-<team>.vercel.app
    [
      'https://tallyroom-git-{branch-slug}-goats-projects-3f023cc9.vercel.app',
      { pr: 27, branch: 'polish-readme-hairline', sha: SHA },
      'https://tallyroom-git-polish-readme-hairline-goats-projects-3f023cc9.vercel.app',
    ],
    // Cloudflare Pages branch alias: <branch-slug>.<project>.pages.dev
    [
      'https://{branch-slug}.roomtrace.pages.dev',
      { pr: 3, branch: 'fix/api', sha: SHA },
      'https://fix-api.roomtrace.pages.dev',
    ],
    // Netlify deploy preview: deploy-preview-<pr>--<site>.netlify.app
    [
      'https://deploy-preview-{pr}--myshop.netlify.app',
      { pr: 12, branch: 'anything', sha: SHA },
      'https://deploy-preview-12--myshop.netlify.app',
    ],
    // A fixed staging URL is a valid template too (nothing to fill).
    ['https://stage.example.com/', {}, 'https://stage.example.com/'],
    // Per-commit hosts.
    [
      'https://{short-sha}.preview.example.com',
      { sha: SHA },
      'https://7e1d0ca.preview.example.com',
    ],
  ];
  for (const [template, vars, expected] of rows) {
    it(`renders ${template}`, () => {
      expect(renderUrlTemplate(template, vars)).toBe(expected);
    });
  }
});

describe('branchSlug', () => {
  const rows: Array<[string, string]> = [
    ['feat/Login_Form', 'feat-login-form'],
    ['fix/Ballot_Header', 'fix-ballot-header'],
    ['main', 'main'],
    ['release/2026.10', 'release-2026-10'],
    // A run of separators collapses to one dash; none survive at the ends.
    ['feat//x', 'feat-x'],
    ['-lead_and-trail-', 'lead-and-trail'],
    ['UPPER', 'upper'],
    ['émoji-✓-branch', 'moji-branch'],
  ];
  for (const [branch, slug] of rows) {
    it(`${JSON.stringify(branch)} → ${slug}`, () => {
      expect(branchSlug(branch)).toBe(slug);
    });
  }
});

describe('missingPlaceholders', () => {
  it('names each placeholder the context cannot fill, once', () => {
    expect(
      missingPlaceholders('https://{branch-slug}.x.com/{pr}/{pr}/{sha}', { sha: 'abc' }),
    ).toEqual(['{branch-slug}', '{pr}']);
  });

  it('is empty when everything renders', () => {
    expect(missingPlaceholders('https://pr-{pr}.x.com', { pr: 1 })).toEqual([]);
    expect(missingPlaceholders('https://static.example.com', {})).toEqual([]);
  });
});

describe('validateUrlTemplate', () => {
  it('accepts a well-formed template', () => {
    expect(validateUrlTemplate('https://pr-{pr}.preview.example.com')).toBeNull();
  });

  it('rejects templates that do not render to a URL', () => {
    expect(validateUrlTemplate('pr-{pr}.example.com')).toContain('valid URL');
  });

  it('rejects non-http protocols', () => {
    expect(validateUrlTemplate('ftp://files-{pr}.example.com')).toContain('http(s)');
  });
});

describe('renderUrlTemplate — a placeholder in the host part stays a hostname label', () => {
  const hostile = { pr: 7, branch: 'attacker.example/x', sha: 'a'.repeat(40) };

  it('refuses a raw {branch} in the host whose value would change the host', () => {
    expect(renderUrlTemplate('https://{branch}.preview.example.com', hostile)).toBeNull();
    expect(unsafeHostPlaceholders('https://{branch}.preview.example.com', hostile)).toEqual([
      '{branch} = "attacker.example/x"',
    ]);
    // Nothing is missing — the refusal is the host rule, not an absent value.
    expect(missingPlaceholders('https://{branch}.preview.example.com', hostile)).toEqual([]);
  });

  it('a dot alone is enough: a subdomain-looking branch may not add labels', () => {
    expect(
      renderUrlTemplate('https://{branch}.preview.example.com', { ...hostile, branch: 'a.b' }),
    ).toBeNull();
  });

  it('{branch-slug}, {pr} and the sha placeholders always pass, in the same position', () => {
    expect(renderUrlTemplate('https://{branch-slug}.preview.example.com', hostile)).toBe(
      'https://attacker-example-x.preview.example.com',
    );
    expect(renderUrlTemplate('https://pr-{pr}-{short-sha}.preview.example.com', hostile)).toBe(
      'https://pr-7-aaaaaaa.preview.example.com',
    );
    expect(unsafeHostPlaceholders('https://{branch-slug}.preview.example.com', hostile)).toEqual(
      [],
    );
  });

  it('the same {branch} in the path is left alone — it cannot move the host', () => {
    expect(renderUrlTemplate('https://preview.example.com/{branch}/', hostile)).toBe(
      'https://preview.example.com/attacker.example/x/',
    );
    expect(unsafeHostPlaceholders('https://preview.example.com/{branch}/', hostile)).toEqual([]);
  });

  it('a hostname-safe branch renders in the host as before', () => {
    expect(
      renderUrlTemplate('https://{branch}.preview.example.com', { ...hostile, branch: 'main' }),
    ).toBe('https://main.preview.example.com');
  });
});
