/**
 * Plain text for a value recorded in a history entry (audit before/after):
 * nested objects become "key: value" pairs. Staff-facing only.
 */
export function showValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(showValue).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${showValue(v)}`)
      .join(' · ');
  }
  return '—';
}
