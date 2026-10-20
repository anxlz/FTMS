'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Field, FormError, SubmitButton } from '@/components/form-controls';
import { forgotPasswordAction, resetPasswordAction } from '@/lib/auth/actions';
import { type FormState, IDLE } from '@/lib/forms';

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgot');
  const tp = useTranslations('auth.setPassword');
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [requested, request] = useActionState(async (previous: FormState, data: FormData) => {
    const result = await forgotPasswordAction(previous, data);
    if (result.status === 'success' && result.email) {
      setEmail(result.email);
      setStep('code');
    }
    return result;
  }, IDLE);
  const [reset, submitReset] = useActionState(resetPasswordAction, IDLE);

  if (reset.status === 'success') {
    return (
      <div className="stack">
        <p className="alert alert-success" role="status">
          {t('done')}
        </p>
        <Link className="btn btn-primary" href="/login">
          {t('backToLogin')}
        </Link>
      </div>
    );
  }

  if (step === 'email') {
    return (
      <form action={request} className="stack" noValidate>
        <FormError state={requested} />
        <Field
          label={t('email')}
          name="email"
          type="email"
          autoComplete="email"
          required
          dir="ltr"
          defaultValue={requested.values?.email ?? email}
          errors={requested.fieldErrors?.email}
        />
        <SubmitButton>{t('send')}</SubmitButton>
        <Link href="/login">{t('backToLogin')}</Link>
      </form>
    );
  }

  return (
    <form action={submitReset} className="stack" noValidate>
      <p className="alert alert-info" role="status">
        {t('sent')}
      </p>
      <FormError state={reset} />
      <input type="hidden" name="email" value={email} />
      <Field
        label={t('code')}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        dir="ltr"
        errors={reset.fieldErrors?.code}
      />
      <Field
        label={t('newPassword')}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        hint={tp('policy')}
        errors={reset.fieldErrors?.newPassword}
      />
      <Field
        label={t('confirmPassword')}
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        errors={reset.fieldErrors?.confirmPassword}
      />
      <SubmitButton>{t('submit')}</SubmitButton>
      <button type="button" className="btn btn-link" onClick={() => setStep('email')}>
        {t('send')}
      </button>
    </form>
  );
}
