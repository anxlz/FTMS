'use client';

import { type Role } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/form-controls';
import { type FormState, IDLE } from '@/lib/forms';
import { createUserAction } from './actions';

export function CreateUserForm({ roles }: { roles: Role[] }) {
  const t = useTranslations();
  const [role, setRole] = useState<Role>(roles.includes('FACULTY') ? 'FACULTY' : roles[0]!);
  const [created, setCreated] = useState(0);
  const [state, action] = useActionState(async (previous: FormState, data: FormData) => {
    const result = await createUserAction(previous, data);
    if (result.status === 'success') setCreated((n) => n + 1);
    return result;
  }, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="stack" noValidate key={created}>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('admin.created')}</FormSuccess>
      <div className="field">
        <label htmlFor="new-role">{t('admin.fields.role')}</label>
        <select
          id="new-role"
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </select>
      </div>
      <Field
        label={t('admin.fields.email')}
        name="email"
        type="email"
        required
        dir="ltr"
        defaultValue={state.values?.email}
        errors={errors.email}
      />
      <Field
        label={t('admin.fields.fullName')}
        name="fullName"
        required
        defaultValue={state.values?.fullName}
        errors={errors.fullName}
      />
      {role === 'STUDENT' ? (
        <Field
          label={t('admin.fields.seatNumber')}
          name="seatNumber"
          required
          dir="ltr"
          defaultValue={state.values?.seatNumber}
          errors={errors.seatNumber}
        />
      ) : (
        <>
          <Field
            label={t('admin.fields.academicTitle')}
            name="academicTitle"
            defaultValue={state.values?.academicTitle}
            errors={errors.academicTitle}
          />
          <Field
            label={t('admin.fields.department')}
            name="department"
            defaultValue={state.values?.department}
            errors={errors.department}
          />
        </>
      )}
      <SubmitButton>{t('admin.create')}</SubmitButton>
    </form>
  );
}
