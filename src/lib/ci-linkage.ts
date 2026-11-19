/**
 * Whether a string is a GitHub `owner/repo` slug. The character class matches
 * what GitHub itself allows in owner/repo names, but admits `.`/`..`, which
 * are path segments rather than names, so those are refused explicitly.
 */
export function isValidRepoSlug(slug: string): boolean {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) return false;
  return slug.split('/').every(segment => segment !== '.' && segment !== '..');
}

/**
 * `owner/repo` from a git remote URL. Handles the three shapes a cloned repo
 * actually carries — SSH (`git@github.com:o/r.git`), HTTPS, and the `ssh://`
 * form — and returns null for anything not on github.com.
 */
export function parseRepoSlug(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;
  const match =
    /^git@github\.com:(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(url) ??
    /^ssh:\/\/git@github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(url) ??
    /^https?:\/\/(?:[^@]+@)?github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  const slug = match?.groups?.slug;
  if (!slug) return null;
  return isValidRepoSlug(slug) ? slug : null;
}
