'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Field, FormError, SubmitButton } from '@/components/form-controls';
import { signupRequestAction, signupVerifyAction } from '@/lib/auth/actions';
import { type FormState, IDLE } from '@/lib/forms';

const NAME_FIELDS = ['firstName', 'fatherName', 'grandfatherName', 'familyName'] as const;

/**
 * Student signup (§4.2): four-part name, seat number and university email, then
 * the emailed code. The details travel with the code so the API can match them
 * against imported records only after the email is proven.
 */
export function SignupForm() {
  const t = useTranslations('auth.signup');
  const [step, setStep] = useState<'details' | 'code'>('details');
  const [details, setDetails] = useState<Record<string, string>>({});
  const [requested, request] = useActionState(async (previous: FormState, data: FormData) => {
    const result = await signupRequestAction(previous, data);
    if (result.status === 'success' && result.values) {
      setDetails(result.values);
      setStep('code');
    }
    return result;
  }, IDLE);
  const [verified, verify] = useActionState(signupVerifyAction, IDLE);
  const values = requested.values ?? details;
  const errors = requested.fieldErrors ?? {};

  if (step === 'details') {
    return (
      <form action={request} className="stack" noValidate>
        <FormError state={requested} />
        <div className="grid-2">
          {NAME_FIELDS.map((name) => (
            <Field
              key={name}
              label={t(name)}
              name={name}
              required
              autoComplete="off"
              defaultValue={values[name]}
              errors={errors[name]}
            />
          ))}
        </div>
        <Field
          label={t('seatNumber')}
          name="seatNumber"
          required
          dir="ltr"
          defaultValue={values.seatNumber}
          errors={errors.seatNumber}
        />
        <Field
          label={t('email')}
          name="email"
          type="email"
          autoComplete="email"
          required
          dir="ltr"
          hint={t('emailHint')}
          defaultValue={values.email}
          errors={errors.email}
        />
        <SubmitButton>{t('send')}</SubmitButton>
        <p className="muted small">
          {t('haveAccount')} <Link href="/login">{t('signIn')}</Link>
        </p>
      </form>
    );
  }

  return (
    <form action={verify} className="stack" noValidate>
      <p className="alert alert-info" role="status">
        {t('sent')}
      </p>
      <FormError state={verified} />
      {Object.entries(details).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="muted" dir="ltr">
        {details.email}
      </p>
      <Field
        label={t('code')}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        dir="ltr"
        errors={verified.fieldErrors?.code}
      />
      <SubmitButton>{t('verify')}</SubmitButton>
      <button type="button" className="btn btn-link" onClick={() => setStep('details')}>
        {t('back')}
      </button>
    </form>
  );
}
