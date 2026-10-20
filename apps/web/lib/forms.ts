import { type ApiResult } from './api';

/** State returned by every server action to its form. Serializable by design. */
export interface FormState {
  status: 'idle' | 'error' | 'success';
  /** API error code (or NETWORK / PASSWORDS_DONT_MATCH), translated by the form. */
  error?: string;
  retryAfterMinutes?: number;
  /** Field → list of codes (validation codes or password-policy violations). */
  fieldErrors?: Record<string, string[]>;
  /** Multi-step forms (email → code). */
  step?: string;
  /** Value to carry into the next step (e.g. the email the code was sent to). */
  email?: string;
  /**
   * Non-secret values to show again after a failed submit. React 19 resets
   * uncontrolled fields after every form action; passwords are never echoed.
   */
  values?: Record<string, string>;
}

export const IDLE: FormState = { status: 'idle' };

export const field = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
};

/** Converts an API failure into form state. */
export function failure(
  result: Extract<ApiResult<unknown>, { ok: false }>,
  values?: Record<string, string>,
): FormState {
  return {
    status: 'error',
    values,
    error: result.code,
    retryAfterMinutes: result.retryAfterSeconds
      ? Math.max(1, Math.ceil(result.retryAfterSeconds / 60))
      : undefined,
    fieldErrors: result.details,
  };
}

/** Picks the named fields from submitted form data (for re-display after an error). */
export const echo = (data: FormData, names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, field(data, name)]));

export function passwordsMismatch(): FormState {
  return {
    status: 'error',
    error: 'PASSWORDS_DONT_MATCH',
    fieldErrors: { confirmPassword: ['PASSWORDS_DONT_MATCH'] },
  };
}
