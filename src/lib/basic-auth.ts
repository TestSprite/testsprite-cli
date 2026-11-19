/** Return the RFC 7617 token, accepting raw UTF-8 pairs and existing base64 credentials. */
export function basicAuthToken(credential: string): string | null {
  const raw = credential.includes(':');
  const token = raw ? '' : credential.trim().replace(/^basic[ \t]+/i, '');
  const pair = raw ? Buffer.from(credential, 'utf8') : Buffer.from(token, 'base64');
  if (!pair.includes(0x3a) || pair.some(byte => byte < 0x20 || byte === 0x7f)) return null;

  const encoded = pair.toString('base64');
  // Buffer.from silently skips invalid characters and accepts partial padding.
  if (!raw && token !== encoded && token !== encoded.replace(/=+$/, '')) return null;
  return encoded;
}

export const BASIC_AUTH_FORMAT = 'Basic auth requires username:password or its base64 encoding.';
