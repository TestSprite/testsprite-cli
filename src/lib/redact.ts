/**
 * Secret-redaction utility for CLI output, logs, and future TTS content.
 *
 * Scans strings for patterns that look like secrets — API keys, bearer
 * tokens, passwords in URLs, and generic high-entropy hex/base64 strings
 * — and replaces them with a fixed placeholder so they never appear in
 * terminal output, persisted logs, checkpoints, or spoken announcements.
 *
 * Design notes:
 *   - Patterns are intentionally broad rather than precise. A false
 *     positive (redacting a harmless string) is always preferable to a
 *     false negative (leaking a real secret).
 *   - The replacement placeholder includes the pattern name so an
 *     operator can tell *which* kind of value was removed without
 *     seeing the value itself.
 *   - `redactSecrets` is idempotent — running it twice on already-
 *     redacted text produces the same output.
 *   - Custom patterns can be added via `createRedactor` for project-
 *     specific secret formats.
 *   - This module has zero external dependencies.
 */

/** Default placeholder template. `{name}` is replaced by the pattern label. */
const DEFAULT_PLACEHOLDER = '[REDACTED:{name}]';

/**
 * A named pattern that matches secret-shaped text.
 *
 * @param name   Human-readable label included in the placeholder
 *               (e.g. `"api-key"`, `"bearer-token"`).
 * @param regex  Pattern to match. Must use the global flag (`g`) so
 *               `String.replace` replaces every occurrence.
 */
export interface RedactionPattern {
  name: string;
  regex: RegExp;
}

/**
 * Built-in patterns covering the most common secret shapes seen in
 * CLI / API environments. Ordered from most-specific to most-generic
 * so specific labels win when patterns overlap.
 */
export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  // TestSprite API keys: `sk-` followed by 20+ alphanumeric chars
  { name: 'api-key', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },

  // Bearer / token authorization header values
  { name: 'bearer-token', regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}\b/g },

  // Generic `token=<value>` or `token: <value>` in logs/config
  {
    name: 'token',
    regex: /\b(?:token|access_token|refresh_token)[=:]\s*['"]?[A-Za-z0-9._~+/=-]{16,}['"]?/gi,
  },

  // Password in URLs: `://user:password@host`
  { name: 'url-password', regex: /:\/\/[^@/\s]+:([^@/\s]+)@/g },

  // AWS-style keys: AKIA followed by 16 uppercase alphanumeric
  { name: 'aws-key', regex: /\bAKIA[A-Z0-9]{16}\b/g },

  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ prefix
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },

  // Generic hex secrets: 32+ consecutive hex chars (SHA-256, API keys, etc.)
  // Only matches lowercase or mixed-case to reduce false positives on UUIDs.
  { name: 'hex-secret', regex: /\b[0-9a-f]{32,}\b/g },
];

/**
 * Redact secrets from a string using the default built-in patterns.
 *
 * @param input  The string to scan and redact.
 * @returns A new string with every matched secret replaced by a
 *   `[REDACTED:<pattern-name>]` placeholder.
 *
 * @example
 *   redactSecrets('key=sk-abc123def456ghi789jkl012')
 *   // → 'key=[REDACTED:api-key]'
 *
 *   redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI...')
 *   // → 'Authorization: [REDACTED:bearer-token]'
 */
export function redactSecrets(input: string): string {
  return redactWithPatterns(input, DEFAULT_PATTERNS);
}

/**
 * Create a custom redactor with additional project-specific patterns
 * prepended to the built-in defaults. Custom patterns take precedence
 * because they run first.
 *
 * @param extraPatterns  Additional patterns to match before the defaults.
 * @returns A redaction function with the same signature as `redactSecrets`.
 *
 * @example
 *   const redact = createRedactor([
 *     { name: 'internal-key', regex: /\bINT-[A-Za-z0-9]{24}\b/g },
 *   ]);
 *   redact('token REDACTED key=INT-abc123...')
 */
export function createRedactor(
  extraPatterns: readonly RedactionPattern[],
): (input: string) => string {
  const allPatterns = [...extraPatterns, ...DEFAULT_PATTERNS];
  return (input: string) => redactWithPatterns(input, allPatterns);
}

/**
 * Internal: apply an ordered list of patterns to a string, replacing
 * every match with a labelled placeholder.
 *
 * Each pattern's regex is cloned via `new RegExp` so the shared global
 * regex's `lastIndex` is reset on every call — without this, consecutive
 * calls to `redactSecrets` on different strings would skip matches
 * because `RegExp.prototype[Symbol.replace]` with a `g` flag mutates
 * `lastIndex`.
 */
function redactWithPatterns(input: string, patterns: readonly RedactionPattern[]): string {
  let result = input;
  for (const pattern of patterns) {
    const placeholder = DEFAULT_PLACEHOLDER.replace('{name}', pattern.name);
    // Clone to reset lastIndex — global regexes are stateful.
    const freshRegex = new RegExp(pattern.regex.source, pattern.regex.flags);

    if (pattern.name === 'url-password') {
      // Special handling: only redact the password capture group, not the
      // entire URL structure. Replace `://user:PASSWORD@` with `://user:[REDACTED]@`.
      result = result.replace(freshRegex, (match, password: string) =>
        match.replace(password, placeholder),
      );
    } else {
      result = result.replace(freshRegex, placeholder);
    }
  }
  return result;
}
