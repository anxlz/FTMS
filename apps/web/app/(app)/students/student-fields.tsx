'use client';

import { type Group } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
} from '@/components/form-controls';
import { type FormState, IDLE } from '@/lib/forms';
import { createStudentAction, updateStudentAction } from './actions';

const NAME_FIELDS = ['firstName', 'fatherName', 'grandfatherName', 'familyName'] as const;

export interface StudentValues {
  seatNumber?: string;
  firstName?: string | null;
  fatherName?: string | null;
  grandfatherName?: string | null;
  familyName?: string | null;
  universityEmail?: string | null;
  phone?: string | null;
}

/** The record's own fields, shared by the create and edit forms. */
function RecordFields({
  state,
  initial,
  emailLocked,
}: {
  state: FormState;
  initial: StudentValues;
  emailLocked?: boolean;
}) {
  const t = useTranslations('students.fields');
  const errors = state.fieldErrors ?? {};
  const value = (name: keyof StudentValues) => state.values?.[name] ?? initial[name] ?? '';
  return (
    <>
      <Field
        label={t('seatNumber')}
        name="seatNumber"
        required
        dir="ltr"
        defaultValue={value('seatNumber')}
        errors={errors.seatNumber}
      />
      <div className="grid-2">
        {NAME_FIELDS.map((name) => (
          <Field
            key={name}
            label={name === 'firstName' ? t(name) : `${t(name)} ${t('optionalSuffix')}`}
            name={name}
            required={name === 'firstName'}
            defaultValue={value(name)}
            errors={errors[name]}
          />
        ))}
      </div>
      <div className="grid-2">
        <Field
          label={`${t('universityEmail')} ${t('optionalSuffix')}`}
          name="universityEmail"
          type="email"
          dir="ltr"
          readOnly={emailLocked}
          hint={emailLocked ? t('emailLockedHint') : undefined}
          defaultValue={value('universityEmail')}
          errors={errors.universityEmail}
        />
        <Field
          label={`${t('phone')} ${t('optionalSuffix')}`}
          name="phone"
          dir="ltr"
          inputMode="tel"
          defaultValue={value('phone')}
          errors={errors.phone}
        />
      </div>
    </>
  );
}

export function CreateStudentForm({ groups }: { groups: Group[] | null }) {
  const t = useTranslations('students');
  const [state, action] = useActionState(createStudentAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <RecordFields state={state} initial={{}} />
      {groups && (
        <SelectField
          label={t('fields.group')}
          name="groupId"
          defaultValue={state.values?.groupId ?? ''}
          options={[
            { value: '', label: t('fields.noGroup') },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
          errors={state.fieldErrors?.groupId}
        />
      )}
      <SubmitButton>{t('add')}</SubmitButton>
    </form>
  );
}

export function EditStudentForm({
  id,
  initial,
  emailLocked,
}: {
  id: string;
  initial: StudentValues;
  emailLocked: boolean;
}) {
  const t = useTranslations('students');
  const [state, action] = useActionState(updateStudentAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('detail.saved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="emailLocked" value={String(emailLocked)} />
      {NAME_FIELDS.map((name) => (
        <input key={name} type="hidden" name={`original.${name}`} value={initial[name] ?? ''} />
      ))}
      <RecordFields state={state} initial={initial} emailLocked={emailLocked} />
      <Field
        label={t('fields.reason')}
        name="reason"
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton>{t('detail.save')}</SubmitButton>
    </form>
  );
}
