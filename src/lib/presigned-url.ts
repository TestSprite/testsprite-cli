import { ApiError } from './errors.js';
import { assertNotLocal } from './target-url.js';

/**
 * Defense-in-depth on the server-minted presigned URL.
 *
 * A REMOTE facade must mint a non-local `https:` URL; a localhost/private or
 * plain-http mint from a remote facade is exactly the anomaly to reject
 * (compromised/misconfigured facade or an active MITM) — the PUT would
 * otherwise send the user's file wherever that URL points, before any bytes
 * leave the machine. A facade that is ITSELF loopback (dev rig, localhost
 * e2e) is a deliberate operator configuration and is trusted to mint local
 * URLs — and ONLY loopback qualifies: the gate is a positive, fail-closed
 * check, because gating on "anything `assertNotLocal` dislikes" would
 * silently disable the guard for an unparsable base URL or a user-settable
 * private-range endpoint (`--endpoint-url https://10.1.2.3`). Literal checks
 * only (same scope as `assertNotLocal`); no host allow-listing by design.
 *
 * Known residual: a loopback facade that is really a TUNNEL to a remote
 * backend (`ssh -L`, a localhost corporate proxy) is trusted here even though
 * the real conversation is remote and MITM-able upstream. This is inherent to
 * "loopback facade = trusted dev rig" and accepted — the CLI cannot tell a
 * dev rig from a tunnel by the base URL alone.
 */
export function assertSafePresignedUploadUrl(uploadUrl: string, facadeBaseUrl: string): void {
  if (isLoopbackFacade(facadeBaseUrl)) return;
  const reject = (reason: string): never => {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Refusing the presigned upload URL the server returned: ${reason}.`,
        nextAction:
          'No bytes were uploaded. This can indicate a misconfigured or intercepted API ' +
          'endpoint — verify --endpoint-url / TESTSPRITE_API_URL and retry.',
        requestId: 'local',
        details: { field: 'uploadUrl', reason: 'unsafe_presigned_url' },
      },
    });
  };
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    return reject('it is not a valid URL');
  }
  if (parsed.protocol !== 'https:') return reject('it is not https');
  if (isLocalUrl(uploadUrl)) return reject('it points at a local/private address');
}

/** True when `assertNotLocal` rejects the URL (localhost, RFC1918, link-local,
 *  metadata, non-http(s), unparsable). Fail-closed in the REJECTION direction
 *  only — used to refuse a suspicious mint, never to grant trust (that side
 *  is `isLoopbackFacade`). */
function isLocalUrl(url: string): boolean {
  try {
    assertNotLocal(url, {
      field: 'upload-url',
      helpCommand: 'testsprite plan',
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * The facade-trust gate for `assertSafePresignedUploadUrl`.
 * Positive and narrow — only an explicitly-loopback facade (`localhost`,
 * a `127.0.0.0/8` literal, or `[::1]`) is trusted to mint local upload URLs.
 * Anything else — including an unparsable base URL or a private-range
 * endpoint — leaves the guard ON.
 */
function isLoopbackFacade(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `localhost.` is the fully-qualified form of `localhost` (RFC 6761).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return host === '[::1]';
}
