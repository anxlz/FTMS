/**
 * Where to continue after signing in, from a `?next=` parameter. Only the app's
 * own pages qualify (e.g. a scanned check-in link): a path on this origin, never
 * another site (`//host`, `/\host`), a scheme, or control characters.
 */
export function safeNext(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  if (!/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/.test(value)) return null;
  return value;
}
