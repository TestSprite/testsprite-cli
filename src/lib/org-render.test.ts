import { describe, expect, it } from 'vitest';
import { formatOrgBinding, formatOrgsSummary, formatPersonalScopeHint } from './org-render.js';

describe('formatOrgsSummary', () => {
  it('returns undefined when organizations is undefined', () => {
    expect(formatOrgsSummary(undefined)).toBeUndefined();
  });

  it('returns undefined when organizations is an empty array', () => {
    expect(formatOrgsSummary([])).toBeUndefined();
  });

  it('renders a single organization', () => {
    const out = formatOrgsSummary([
      { id: 'org_1', name: 'Acme Corp', role: 'owner', isPersonal: false },
    ]);
    expect(out).toBe('Acme Corp (org_1, role: owner)');
  });

  it('renders multiple organizations, semicolon-separated', () => {
    const out = formatOrgsSummary([
      { id: 'org_1', name: 'Acme Corp', role: 'owner', isPersonal: false },
      { id: 'org_2', name: "Jane's workspace", role: 'member', isPersonal: true },
    ]);
    expect(out).toBe(
      "Acme Corp (org_1, role: owner); Jane's workspace (org_2, personal, role: member)",
    );
  });

  it('marks the personal org distinctly', () => {
    const out = formatOrgsSummary([
      { id: 'org_personal', name: "Jane's workspace", role: 'owner', isPersonal: true },
    ]);
    expect(out).toContain(', personal, role: owner');
  });
});

describe('formatOrgBinding', () => {
  it('returns undefined when org is undefined (legacy key, or older backend)', () => {
    expect(formatOrgBinding(undefined)).toBeUndefined();
  });

  it('renders the binding with a resolved name', () => {
    const out = formatOrgBinding({ id: 'org_1', name: 'Acme Corp', role: 'member' });
    expect(out).toBe('Acme Corp (org_1, role: member)');
  });

  it('falls back to the id when name resolution failed (name: null)', () => {
    const out = formatOrgBinding({ id: 'org_1', name: null, role: 'member' });
    expect(out).toBe('org_1 (org_1, role: member)');
  });
});

describe('formatPersonalScopeHint', () => {
  const personal = { id: 'org-p', name: 'Duke', role: 'owner', isPersonal: true };
  const team = { id: 'org-t', name: 'Acme', role: 'member', isPersonal: false };

  it('names the workspaces an unbound key cannot reach', () => {
    const hint = formatPersonalScopeHint([personal, team], undefined);
    expect(hint).toContain('Acme');
    expect(hint).toContain('Settings → API Keys');
  });

  it('says nothing when the key is already workspace-bound', () => {
    expect(
      formatPersonalScopeHint([personal, team], { id: 'org-t', name: 'Acme', role: 'member' }),
    ).toBeUndefined();
  });

  it('says nothing for a solo user — there is no other workspace to miss', () => {
    expect(formatPersonalScopeHint([personal], undefined)).toBeUndefined();
  });

  it('is absent-safe when the backend omits organizations', () => {
    expect(formatPersonalScopeHint(undefined, undefined)).toBeUndefined();
  });

  it('lists every team workspace, not just the first', () => {
    const hint = formatPersonalScopeHint(
      [personal, team, { id: 'org-u', name: 'Globex', role: 'admin', isPersonal: false }],
      undefined,
    );
    expect(hint).toContain('Acme, Globex');
  });
});
