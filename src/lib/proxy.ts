/**
 * Proxy support (issue #119): honor HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
 *
 * Node's built-in fetch (undici) deliberately ignores the proxy environment
 * variables, so behind a corporate or CI proxy every request dies with
 * `fetch failed` after a full retry cycle. Installing undici's
 * `EnvHttpProxyAgent` as the global dispatcher restores the conventional
 * behavior (including NO_PROXY exemptions) for every fetch the CLI makes.
 *
 * Only active when a proxy env var is actually present, so the default path
 * stays byte-identical and pays zero startup cost. Dependency note for
 * reviewers: this adds `undici` as an explicit runtime dependency (the same
 * engine Node already bundles); the alternative, a hand-rolled CONNECT
 * tunnel, would re-implement what undici ships and maintains.
 */
import type { Dispatcher } from 'undici';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

export interface ProxyDeps {
  env?: NodeJS.ProcessEnv;
  /** Dispatcher installer. Defaults to undici's setGlobalDispatcher. */
  install?: (agent: Dispatcher) => void;
  /** Warning sink. Defaults to `process.stderr`. */
  stderr?: (line: string) => void;
}

/**
 * Install the env-driven proxy dispatcher when any proxy variable is set
 * (both canonical upper-case and conventional lower-case spellings).
 * Returns whether an agent was installed (observable for tests/debugging).
 */
export function maybeInstallProxyAgent(deps: ProxyDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const hasProxy = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy].some(
    value => typeof value === 'string' && value.length > 0,
  );
  if (!hasProxy) return false;
  const install = deps.install ?? setGlobalDispatcher;
  // EnvHttpProxyAgent reads HTTPS_PROXY/HTTP_PROXY/NO_PROXY itself, per
  // request, so NO_PROXY exemptions apply without extra plumbing here.
  //
  // A malformed or unsupported proxy value (e.g. `socks5://...`) makes the
  // agent throw. Because this runs at startup, an unguarded throw would abort
  // every command before the CLI's own error handling — so fall back to the
  // default (proxy-less) dispatcher and warn instead of crashing.
  try {
    install(new EnvHttpProxyAgent());
    return true;
  } catch (error) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(
      `warning: ignoring proxy environment (could not initialize proxy agent): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Whether the currently-installed global dispatcher is the proxy-aware
 * agent `maybeInstallProxyAgent` installs — i.e., whether a proxy is
 * actually wired up for outgoing `fetch()` calls in this process, not
 * merely whether an `HTTP(S)_PROXY` env var happens to be set.
 *
 * This distinction matters: a CI runner can export `HTTPS_PROXY` for
 * unrelated registry/package-manager egress without that value ever
 * reaching this CLI's proxy path (e.g. it ran before `maybeInstallProxyAgent`
 * executed, or `install()` threw and fell back to the default dispatcher).
 * Consumers that need to know "is my request actually going through a
 * proxy" — the target-url reachability preflight's refuse→warn downgrade,
 * specifically — must check this, not the env var, or an unrelated,
 * unexercised proxy variable silently defangs their guard.
 */
export function isProxyAgentActive(): boolean {
  return getGlobalDispatcher() instanceof EnvHttpProxyAgent;
}
