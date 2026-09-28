/**
 * Sensitive Data Redaction Engine (F3-06)
 *
 * Recursively inspects and redacts sensitive credentials, tokens, keys,
 * passwords, and certificates from data structures before canonical
 * hashing, persistence, or audit emission.
 */

export const REDACTED_MARKER = '[REDACTED]';

/** Key names that indicate sensitive values (case-insensitive). */
const SENSITIVE_KEY_REGEX =
  /^(password|passwd|pwd|secret|client_?secret|api_?key|access_?token|auth_?token|authorization|private_?key|secret_?key|credentials|privatekey|apikey|accesstoken|authtoken|clientsecret)$/i;

/** String patterns for known token / credential formats. */
const SENSITIVE_PATTERNS: Array<{ regex: RegExp; replace: string }> = [
  // PEM Private Keys (RSA, EC, PKCS8, OpenSSH)
  {
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  // OpenAI API keys
  {
    regex: /sk-[a-zA-Z0-9_-]{20,}/g,
    replace: REDACTED_MARKER,
  },
  // Anthropic API keys
  {
    regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    replace: REDACTED_MARKER,
  },
  // Generic API keys (key-xxxx...)
  {
    regex: /key-[a-zA-Z0-9]{16,}/g,
    replace: REDACTED_MARKER,
  },
  // JWT tokens (three base64url segments starting with eyJ)
  {
    regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    replace: '[REDACTED_JWT]',
  },
  // Bearer authentication headers / tokens
  {
    regex: /Bearer\s+[a-zA-Z0-9._\-+/=]{10,}/gi,
    replace: 'Bearer [REDACTED]',
  },
  // Basic authentication headers
  {
    regex: /Basic\s+[a-zA-Z0-9+/=]{12,}/gi,
    replace: 'Basic [REDACTED]',
  },
  // AWS Access Key ID
  {
    regex: /AKIA[0-9A-Z]{16}/g,
    replace: '[REDACTED_AWS_KEY]',
  },
  // Inline key=value or key: value assignments for sensitive fields (skip already redacted values)
  {
    regex: /(password|secret|api_?key|token|auth)\s*[:=]\s*["']?(?!\[REDACTED)([^\s"'`",;]+)["']?/gi,
    replace: '$1=[REDACTED]',
  },
];

/**
 * Check if an object key name indicates sensitive content.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_REGEX.test(key);
}

/**
 * Redact sensitive patterns from a string.
 */
export function redactSensitiveString(str: string): { sanitized: string; redactedCount: number } {
  let sanitized = str;
  let count = 0;

  for (const { regex, replace } of SENSITIVE_PATTERNS) {
    const matches = sanitized.match(regex);
    if (matches) {
      count += matches.length;
      sanitized = sanitized.replace(regex, replace);
    }
  }

  return { sanitized, redactedCount: count };
}

export interface RedactionResult<T> {
  sanitized: T;
  redactedCount: number;
}

/**
 * Deep recursive redaction of arbitrary values.
 *
 * Traverses objects, arrays, and strings, replacing secrets with redaction markers.
 * Safe against circular references.
 */
export function redactSensitive<T = unknown>(input: T): RedactionResult<T> {
  let totalRedacted = 0;
  const seen = new WeakSet<object>();

  function traverse(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      const { sanitized, redactedCount } = redactSensitiveString(value);
      totalRedacted += redactedCount;
      return sanitized;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) return '[CIRCULAR]';
      seen.add(value);
      return value.map((item) => traverse(item));
    }

    if (typeof value === 'object') {
      if (seen.has(value as object)) return '[CIRCULAR]';
      seen.add(value as object);

      const obj = value as Record<string, unknown>;
      const sanitizedObj: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(obj)) {
        if (isSensitiveKey(k)) {
          // If the key is sensitive, redact its scalar value
          if (typeof v === 'string') {
            const { sanitized, redactedCount } = redactSensitiveString(v);
            if (redactedCount > 0) {
              sanitizedObj[k] = sanitized;
              totalRedacted += redactedCount;
            } else {
              sanitizedObj[k] = REDACTED_MARKER;
              totalRedacted++;
            }
          } else if (typeof v === 'number' || typeof v === 'boolean') {
            sanitizedObj[k] = REDACTED_MARKER;
            totalRedacted++;
          } else if (v && typeof v === 'object') {
            // If it's an object under a sensitive key, redact its contents
            sanitizedObj[k] = traverse(v);
          } else {
            sanitizedObj[k] = REDACTED_MARKER;
            totalRedacted++;
          }
        } else {
          sanitizedObj[k] = traverse(v);
        }
      }

      return sanitizedObj;
    }

    return value;
  }

  const sanitized = traverse(input) as T;
  return { sanitized, redactedCount: totalRedacted };
}
