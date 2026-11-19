/**
 * `ci run --target-url-template`: a pull request's preview address written
 * once, as a pattern, and filled in on the runner from the facts the job
 * already has (PR number, head branch, head sha).
 *
 * The placeholders and the branch slug are the GitHub App's — its PR triggers
 * take the same `urlTemplate` and render it from the webhook payload
 * (backend `trigger-url.util.ts`) — so a pattern copied between the Portal
 * and a workflow file renders the same URL. `url-template.spec.ts` pins the
 * App's own cases alongside the platform shapes this exists for (Vercel's
 * `<project>-git-{branch-slug}-<team>.vercel.app`, Cloudflare Pages'
 * `{branch-slug}.<project>.pages.dev`, Netlify's `deploy-preview-{pr}--<site>`).
 */

const PLACEHOLDER_RE = /\{(pr|pr-number|branch|branch-slug|sha|short-sha)\}/g;

/**
 * What a placeholder may render to inside the template's authority (the host
 * part): hostname-label characters only. `{branch-slug}`, `{pr}` and the sha
 * placeholders always satisfy this; a raw `{branch}` does not when the branch
 * is named `attacker.example/x` — substituted verbatim into
 * `https://{branch}.preview.example.com` that renders to host
 * `attacker.example`, and the run would be dispatched there with the
 * environment's sign-in. Such a value is refused, never dispatched.
 */
const HOST_SAFE_RE = /^[A-Za-z0-9-]+$/;

export const URL_TEMPLATE_PLACEHOLDERS = [
  '{pr}',
  '{pr-number}',
  '{branch}',
  '{branch-slug}',
  '{sha}',
  '{short-sha}',
] as const;

export interface UrlTemplateVars {
  pr?: number | null;
  branch?: string | null;
  sha?: string | null;
}

/** A branch name as the preview platforms spell it in a hostname: lowercased, runs of anything else collapsed to one `-`, none at the ends. */
export function branchSlug(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The value a placeholder renders to, or `null` when `vars` has none for it. */
function placeholderValue(name: string, vars: UrlTemplateVars): string | null {
  switch (name) {
    case 'pr':
    case 'pr-number':
      return vars.pr == null ? null : String(vars.pr);
    case 'branch':
      return vars.branch || null;
    case 'branch-slug':
      return vars.branch ? branchSlug(vars.branch) : null;
    case 'sha':
      return vars.sha || null;
    case 'short-sha':
      return vars.sha ? vars.sha.slice(0, 7) : null;
    default:
      return null;
  }
}

/**
 * The `[start, end)` of the template's authority — from after `scheme://` to
 * the first `/`, `?` or `#` — or `null` when the template has no scheme.
 */
function authoritySpan(template: string): [number, number] | null {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(template);
  if (!scheme) return null;
  const start = scheme[0].length;
  const end = template.slice(start).search(/[/?#]/);
  return [start, end === -1 ? template.length : start + end];
}

/**
 * Fill the template. `null` when a referenced placeholder has no value, or
 * when one inside the host part renders to something that is not a hostname
 * label (see `HOST_SAFE_RE`) — the caller refuses the run rather than guessing
 * (never a production fallback) and names the placeholder with
 * `missingPlaceholders` / `unsafeHostPlaceholders`. Text that merely looks
 * like a placeholder (`{unknown}`) is left as is.
 */
export function renderUrlTemplate(template: string, vars: UrlTemplateVars): string | null {
  const authority = authoritySpan(template);
  let refused = false;
  const rendered = template.replace(PLACEHOLDER_RE, (_m, name: string, offset: number) => {
    const value = placeholderValue(name, vars);
    if (value === null) {
      refused = true;
      return '';
    }
    if (authority && offset >= authority[0] && offset < authority[1] && !HOST_SAFE_RE.test(value)) {
      refused = true;
      return '';
    }
    return value;
  });
  return refused ? null : rendered;
}

/**
 * The placeholders in the template's host part whose value would not stay a
 * hostname label — the ones that make `renderUrlTemplate` refuse although
 * every value is present. Each entry is `{placeholder} = "value"`.
 */
export function unsafeHostPlaceholders(template: string, vars: UrlTemplateVars): string[] {
  const authority = authoritySpan(template);
  if (!authority) return [];
  const unsafe = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const offset = match.index ?? -1;
    if (offset < authority[0] || offset >= authority[1]) continue;
    const value = placeholderValue(match[1]!, vars);
    if (value !== null && !HOST_SAFE_RE.test(value)) {
      unsafe.add(`{${match[1]}} = ${JSON.stringify(value)}`);
    }
  }
  return [...unsafe];
}

/** The placeholders in `template` that `vars` cannot fill — for the refusal message. */
export function missingPlaceholders(template: string, vars: UrlTemplateVars): string[] {
  const missing = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1]!;
    const absent =
      name === 'pr' || name === 'pr-number'
        ? vars.pr == null
        : name === 'branch' || name === 'branch-slug'
          ? !vars.branch
          : !vars.sha;
    if (absent) missing.add(`{${name}}`);
  }
  return [...missing];
}

/**
 * Shape check before any network call: with every placeholder filled by a
 * sample value the template must be an http(s) URL. `null` when it is.
 */
export function validateUrlTemplate(template: string): string | null {
  const rendered = renderUrlTemplate(template, { pr: 1, branch: 'main', sha: 'a'.repeat(40) });
  if (!rendered) return 'the template contains an unknown placeholder';
  let parsed: URL;
  try {
    parsed = new URL(rendered);
  } catch {
    return `the template does not render to a valid URL (placeholders: ${URL_TEMPLATE_PLACEHOLDERS.join(', ')})`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'the template must render to an http(s) URL';
  }
  return null;
}
