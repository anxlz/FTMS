'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { submitVerificationAction } from './actions';

const NAME_FIELDS = ['firstName', 'fatherName', 'grandfatherName', 'familyName'] as const;

export function VerificationForm({ initial }: { initial: Record<string, string> }) {
  const t = useTranslations();
  const [state, action] = useActionState(submitVerificationAction, IDLE);
  const values = state.values ?? initial;
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('verification.submitted')}</FormSuccess>
      <div className="grid-2">
        {NAME_FIELDS.map((name) => (
          <Field
            key={name}
            label={t(`auth.signup.${name}`)}
            name={name}
            required
            defaultValue={values[name]}
            errors={errors[name]}
          />
        ))}
      </div>
      <Field
        label={t('auth.signup.seatNumber')}
        name="seatNumber"
        required
        dir="ltr"
        defaultValue={values.seatNumber}
        errors={errors.seatNumber}
      />
      <SubmitButton>{t('verification.submit')}</SubmitButton>
    </form>
  );
}
