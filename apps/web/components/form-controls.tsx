'use client';

import { useTranslations } from 'next-intl';
import { type InputHTMLAttributes, useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { type FormState } from '@/lib/forms';

/** Form-level error, announced to screen readers. */
export function FormError({ state }: { state: FormState }) {
  const t = useTranslations('errors');
  if (state.status !== 'error' || !state.error) return null;
  const message = t.has(state.error)
    ? t(state.error, { minutes: state.retryAfterMinutes ?? 1 })
    : t('INTERNAL_ERROR');
  return (
    <p className="alert alert-error" role="alert">
      {message}
    </p>
  );
}

export function FormSuccess({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return (
    <p className="alert alert-success" role="status">
      {children}
    </p>
  );
}

/** Field-level errors: password-policy violations get specific text, others a generic hint. */
function FieldErrors({ id, codes }: { id: string; codes?: string[] }) {
  const t = useTranslations('errors');
  if (!codes || codes.length === 0) return null;
  return (
    <ul className="field-errors" id={id}>
      {codes.map((code) => (
        <li key={code}>
          {t.has(`policy.${code}`)
            ? t(`policy.${code}`)
            : /^[A-Z_]+$/.test(code) && t.has(code)
              ? t(code)
              : t('field')}
        </li>
      ))}
    </ul>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  hint?: string;
  errors?: string[];
}

export function Field({ label, name, hint, errors, type = 'text', ...input }: FieldProps) {
  const id = useId();
  const t = useTranslations('common');
  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';
  const describedBy = [hint ? `${id}-hint` : null, errors?.length ? `${id}-errors` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={`field${errors?.length ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="field-control">
        <input
          id={id}
          name={name}
          type={isPassword && visible ? 'text' : type}
          aria-invalid={errors?.length ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...input}
        />
        {isPassword && (
          <button
            type="button"
            className="field-toggle"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
          >
            {visible ? t('hidePassword') : t('showPassword')}
          </button>
        )}
      </div>
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      <FieldErrors id={`${id}-errors`} codes={errors} />
    </div>
  );
}

export function SubmitButton({
  children,
  variant = 'primary',
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const { pending } = useFormStatus();
  const t = useTranslations('common');
  return (
    <button type="submit" className={`btn btn-${variant}`} disabled={pending} aria-busy={pending}>
      {pending ? t('saving') : children}
    </button>
  );
}
