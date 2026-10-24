'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Field, FormError, SubmitButton } from '@/components/form-controls';
import { loginAction, requestCodeAction, verifyCodeAction } from '@/lib/auth/actions';
import { type FormState, IDLE } from '@/lib/forms';

type Tab = 'password' | 'code';

export function LoginForms({ next }: { next?: string }) {
  const t = useTranslations('auth');
  const [tab, setTab] = useState<Tab>('password');

  return (
    <>
      <div className="tabs" role="tablist" aria-label={t('login.title')}>
        {(['password', 'code'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            className={`tab${tab === value ? ' tab-active' : ''}`}
            onClick={() => setTab(value)}
          >
            {value === 'password' ? t('login.tabPassword') : t('login.tabCode')}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'password' ? <PasswordForm next={next} /> : <CodeForm />}
      </div>
    </>
  );
}

function PasswordForm({ next }: { next?: string }) {
  const t = useTranslations('auth.login');
  const [state, action] = useActionState(loginAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      {next && <input type="hidden" name="next" value={next} />}
      <Field
        label={t('identifier')}
        name="identifier"
        autoComplete="username"
        required
        defaultValue={state.values?.identifier}
        errors={state.fieldErrors?.identifier}
        dir="ltr"
      />
      <Field
        label={t('password')}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        errors={state.fieldErrors?.password}
      />
      <SubmitButton>{t('submit')}</SubmitButton>
      <p className="row-between">
        <Link href="/forgot-password">{t('forgot')}</Link>
        <Link href="/signup">{t('signup')}</Link>
      </p>
      <p className="muted small">{t('firstTime')}</p>
    </form>
  );
}

function CodeForm() {
  const t = useTranslations('auth.code');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [requested, request] = useActionState(async (previous: FormState, data: FormData) => {
    const result = await requestCodeAction(previous, data);
    if (result.status === 'success' && result.email) {
      setEmail(result.email);
      setStep('code');
    }
    return result;
  }, IDLE);
  const [verified, verify] = useActionState(verifyCodeAction, IDLE);

  if (step === 'email') {
    return (
      <form action={request} className="stack" noValidate>
        <p className="muted">{t('intro')}</p>
        <FormError state={requested} />
        <Field
          label={t('email')}
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={requested.values?.email ?? email}
          errors={requested.fieldErrors?.email}
          dir="ltr"
        />
        <SubmitButton>{t('send')}</SubmitButton>
      </form>
    );
  }

  return (
    <form action={verify} className="stack" noValidate>
      <p className="alert alert-info" role="status">
        {t('sent')}
      </p>
      <FormError state={verified} />
      <input type="hidden" name="email" value={email} />
      <p className="muted" dir="ltr">
        {email}
      </p>
      <Field
        label={t('code')}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern={'\\d{6}'}
        maxLength={6}
        required
        errors={verified.fieldErrors?.code}
        dir="ltr"
      />
      <SubmitButton>{t('verify')}</SubmitButton>
      <button type="button" className="btn btn-link" onClick={() => setStep('email')}>
        {t('useAnotherEmail')}
      </button>
    </form>
  );
}
