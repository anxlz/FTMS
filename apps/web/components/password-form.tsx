'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { changePasswordAction } from '@/lib/auth/actions';
import { type FormState, IDLE } from '@/lib/forms';
import { Field, FormError, FormSuccess, SubmitButton } from './form-controls';

/** Set the first password, replace a temporary one, or change it from the profile. */
export function PasswordForm({
  requireCurrent,
  next,
  successMessage,
}: {
  requireCurrent: boolean;
  next?: string;
  successMessage?: string;
}) {
  const t = useTranslations('auth.setPassword');
  const [saved, setSaved] = useState(0);
  const [state, action] = useActionState(async (previous: FormState, data: FormData) => {
    const result = await changePasswordAction(previous, data);
    if (result.status === 'success') setSaved((n) => n + 1);
    return result;
  }, IDLE);
  return (
    <form action={action} className="stack" noValidate key={saved}>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success' && Boolean(successMessage)}>
        {successMessage}
      </FormSuccess>
      {next && <input type="hidden" name="next" value={next} />}
      {requireCurrent && (
        <Field
          label={t('current')}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          errors={state.fieldErrors?.currentPassword}
        />
      )}
      <Field
        label={t('newPassword')}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        hint={t('policy')}
        errors={state.fieldErrors?.newPassword}
      />
      <Field
        label={t('confirmPassword')}
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        errors={state.fieldErrors?.confirmPassword}
      />
      <SubmitButton>{t('submit')}</SubmitButton>
    </form>
  );
}
