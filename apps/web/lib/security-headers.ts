/**
 * Browser security policy for every page (§17). The proxy adds the
 * Content-Security-Policy with a fresh nonce per request; next.config adds
 * the static headers to every response, assets included.
 */

/**
 * Scripts run only from this site with the request's nonce ('strict-dynamic'
 * lets those scripts load Next's chunks). Styles allow inline attributes
 * (React `style` props). Images may come from Supabase Storage signed links
 * and QR codes are `data:` SVGs. The browser talks to no other origin: the
 * API is reached by the web server only. Pages cannot be framed.
 */
export function contentSecurityPolicy(
  nonce: string,
  options: { development: boolean; https: boolean },
): string {
  const script = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  // React's development tooling evaluates code and connects over a websocket.
  if (options.development) script.push(`'unsafe-eval'`);
  const directives: Record<string, string[]> = {
    'default-src': [`'self'`],
    'script-src': script,
    'style-src': [`'self'`, `'unsafe-inline'`],
    'img-src': [`'self'`, 'data:', 'blob:', 'https://*.supabase.co'],
    'font-src': [`'self'`, 'data:'],
    'connect-src': options.development ? [`'self'`, 'ws:', 'wss:'] : [`'self'`],
    'frame-src': [`'none'`],
    'frame-ancestors': [`'none'`],
    'object-src': [`'none'`],
    'base-uri': [`'self'`],
    'form-action': [`'self'`],
    'manifest-src': [`'self'`],
    'worker-src': [`'self'`],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (options.https) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

/** A random, base64-encoded nonce (128 bits). Works in the edge and Node runtimes. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Headers for every response. Geolocation and WebAuthn are allowed for this
 * site only (check-in and biometric sign-in, §4.5, §7.2); every other powerful
 * feature is off. HSTS is added by `next.config` in production.
 */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: [
      'geolocation=(self)',
      'publickey-credentials-get=(self)',
      'publickey-credentials-create=(self)',
      'camera=()',
      'microphone=()',
      'payment=()',
      'usb=()',
    ].join(', '),
  },
];

export const HSTS_HEADER = {
  key: 'Strict-Transport-Security',
  value: 'max-age=63072000; includeSubDomains',
};
