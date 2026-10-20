'use client';

import { type OwnStudentProfile } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  Field,
  FormError,
  FormSuccess,
  SubmitButton,
  TextAreaField,
} from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { cancelProfileChangeAction, submitProfileChangeAction, updatePhoneAction } from './actions';

const PROTECTED = [
  'firstName',
  'fatherName',
  'grandfatherName',
  'familyName',
  'seatNumber',
] as const;

export function PhoneForm({ phone }: { phone: string | null }) {
  const t = useTranslations('profile');
  const [state, action] = useActionState(updatePhoneAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('phoneSaved')}</FormSuccess>
      <Field
        label={t('phone')}
        name="phone"
        dir="ltr"
        inputMode="tel"
        autoComplete="tel"
        defaultValue={state.values?.phone ?? phone ?? ''}
        errors={state.fieldErrors?.phone}
      />
      <SubmitButton variant="secondary">{t('savePhone')}</SubmitButton>
    </form>
  );
}

/** Request a correction of identity fields; applied only after faculty approval (§4.4). */
export function ProfileChangeForm({ record }: { record: OwnStudentProfile }) {
  const t = useTranslations();
  const [state, action] = useActionState(submitProfileChangeAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('profile.change.submitted')}</FormSuccess>
      <div className="grid-2">
        {PROTECTED.map((name) => (
          <div key={name}>
            <input type="hidden" name={`current.${name}`} value={record[name] ?? ''} />
            <Field
              label={t(`students.fields.${name}`)}
              name={name}
              dir={name === 'seatNumber' ? 'ltr' : undefined}
              defaultValue={state.values?.[name] ?? record[name] ?? ''}
              errors={errors[name]}
            />
          </div>
        ))}
      </div>
      <TextAreaField
        label={t('profile.change.note')}
        name="note"
        required
        hint={t('profile.change.noteHint')}
        defaultValue={state.values?.note}
        errors={errors.note}
      />
      <SubmitButton>{t('profile.change.submit')}</SubmitButton>
    </form>
  );
}

export function CancelChangeButton({ id }: { id: string }) {
  const t = useTranslations('profile.change');
  const [state, action] = useActionState(cancelProfileChangeAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" confirm={t('cancelConfirm')}>
        {t('cancel')}
      </SubmitButton>
      {state.status === 'error' && <FormError state={state} />}
    </form>
  );
}
