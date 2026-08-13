/**
 * Shared org-attribution text rendering for `auth status`, `usage`, and
 * `doctor` — every surface that reads `GET /me`.
 *
 * `organizations[]` (the caller's full account-wide membership list) and
 * `org` (a membership key's own org binding, present only for a
 * Postgres-backed `sk-member-…` key) are both optional/absent-safe on the `/me`
 * response: older backends omit them entirely, and a lookup hiccup
 * server-side omits `organizations` without failing the request. Callers
 * render a line only when the corresponding formatter returns a non-undefined
 * string — never an `undefined`/`null` literal.
 */

/** One organization from `MeResponse.organizations[]`. */
export interface CliOrgSummary {
  id: string;
  name: string;
  role: string;
  isPersonal: boolean;
}

/** A membership key's own org binding, from `MeResponse.org`. */
export interface CliOrgBinding {
  id: string;
  /** `null` when best-effort name resolution failed or found no match server-side. */
  name: string | null;
  role: string;
}

/**
 * One-line summary of the caller's full membership list, for an `orgs:`
 * line. Returns `undefined` when the list is absent or empty so the caller
 * can omit the line entirely.
 */
export function formatOrgsSummary(
  organizations: readonly CliOrgSummary[] | undefined,
): string | undefined {
  if (!organizations || organizations.length === 0) return undefined;
  return organizations
    .map(o => `${o.name} (${o.id}${o.isPersonal ? ', personal' : ''}, role: ${o.role})`)
    .join('; ');
}

/**
 * One-line summary of a membership key's own org binding, for an
 * `org binding:` line. Returns `undefined` when no binding is present
 * (legacy envelope key, or a backend that doesn't return it).
 */
export function formatOrgBinding(org: CliOrgBinding | undefined): string | undefined {
  if (!org) return undefined;
  const label = org.name ?? org.id;
  return `${label} (${org.id}, role: ${org.role})`;
}

/**
 * Hint for a caller whose key can only reach their personal workspace while
 * they are a member of at least one team workspace.
 *
 * A key is bound to exactly ONE membership — the workspace is chosen when the
 * key is minted, not per command, which is why there is no `--org` flag to
 * reach for. Without this line the failure mode is silent and baffling: the
 * team's projects simply don't appear in `project list`, and addressing one by
 * id 404s exactly like a typo would.
 *
 * Returns `undefined` when the key is already workspace-bound, or when the
 * caller has no team workspace to be confused about.
 */
export function formatPersonalScopeHint(
  organizations: readonly CliOrgSummary[] | undefined,
  org: CliOrgBinding | undefined,
): string | undefined {
  if (org) return undefined;
  const teams = (organizations ?? []).filter(o => !o.isPersonal);
  if (teams.length === 0) return undefined;
  const names = teams.map(o => o.name).join(', ');
  return (
    `this key is scoped to your personal workspace, so nothing in ${names} is reachable with it. ` +
    `A key belongs to one workspace: mint one from that workspace's Settings → API Keys and use it here.`
  );
}
