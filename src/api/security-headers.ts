/**
 * MAOS Security Headers and Content Security Policy (UI1-06)
 *
 * Enforces strict browser-security hardening across all loopback HTTP responses:
 *   - Sovereign Content-Security-Policy (CSP)
 *   - X-Content-Type-Options: nosniff
 *   - Referrer-Policy: no-referrer
 *   - X-Frame-Options: DENY
 *   - Permissions-Policy: restricted hardware/API capabilities
 *   - Cache-Control: no-store (for dynamic and authenticated responses)
 */

import * as http from 'http';

/**
 * The canonical Content Security Policy for the MAOS Sovereign Industrial Desktop/SPA host.
 *
 * Directives:
 * - default-src 'self'
 * - script-src 'self' (NO unsafe-inline, NO unsafe-eval, NO remote CDNs)
 * - style-src 'self' 'unsafe-inline' (Scoped exception: required by React runtime inline styles for dynamic theming)
 * - img-src 'self' data:
 * - font-src 'self' (Offline local fonts only; zero remote font providers)
 * - connect-src 'self' http://127.0.0.1:* http://[::1]:* ws://127.0.0.1:* ws://[::1]:* (Loopback REST/WS only)
 * - object-src 'none' (Zero plugins)
 * - base-uri 'none'
 * - frame-ancestors 'none' (Anti-clickjacking)
 * - form-action 'self'
 * - manifest-src 'self'
 * - worker-src 'self'
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:* http://[::1]:* ws://127.0.0.1:* ws://[::1]:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self';";

/**
 * Standard browser security headers applied to all MAOS HTTP responses.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
});

/**
 * Apply standard security headers to an outgoing HTTP response.
 */
export function applySecurityHeaders(
  res: http.ServerResponse,
  overrides?: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      res.setHeader(key, value);
    }
  }
}
