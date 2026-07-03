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
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

export interface ProxyDeps {
  env?: NodeJS.ProcessEnv;
  /** Dispatcher installer. Defaults to undici's setGlobalDispatcher. */
  install?: (agent: Dispatcher) => void;
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
  install(new EnvHttpProxyAgent());
  return true;
}
