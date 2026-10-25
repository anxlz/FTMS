/** One field of a before/after comparison (§15.3). */
export interface AuditChange {
  /** Dotted path for nested values, e.g. `timing.graceMinutes`. */
  field: string;
  before: unknown;
  after: unknown;
  /** False when the field is shown for context but kept its value. */
  changed: boolean;
}

type Json = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Nested objects become dotted paths (up to a few levels); arrays stay whole. */
function flatten(
  value: Json | null | undefined,
  prefix = '',
  depth = 0,
  out = new Map<string, unknown>(),
) {
  if (!value) return out;
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(inner) && depth < 3 && Object.keys(inner).length > 0) {
      flatten(inner, path, depth + 1, out);
    } else {
      out.set(path, inner);
    }
  }
  return out;
}

/** Stable comparison of JSON values (key order does not matter). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The fields of a before/after pair, in the order they first appear. A value
 * missing on one side is `undefined` there (created or removed).
 */
export function auditChanges(
  before: Json | null | undefined,
  after: Json | null | undefined,
): AuditChange[] {
  const left = flatten(before);
  const right = flatten(after);
  const fields = [...new Set([...left.keys(), ...right.keys()])];
  return fields.map((field) => {
    const b = left.get(field);
    const a = right.get(field);
    return {
      field,
      before: b,
      after: a,
      changed: !(left.has(field) && right.has(field) && canonical(b) === canonical(a)),
    };
  });
}
