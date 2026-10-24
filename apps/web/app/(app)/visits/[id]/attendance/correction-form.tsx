'use client';

import { type AttendanceStatus } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { correctAttendanceAction } from './actions';

/** Faculty correction of one student's record (§8.4). */
export function CorrectionForm({
  visitId,
  studentId,
  current,
}: {
  visitId: string;
  studentId: string;
  current: { status: AttendanceStatus; minutesLate: number } | null;
}) {
  const t = useTranslations('attendance');
  const [state, action] = useActionState(correctAttendanceAction, IDLE);
  const [status, setStatus] = useState<string>(
    state.values?.status ?? current?.status ?? 'PRESENT',
  );
  return (
    <form action={action} className="stack">
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('correction.saved')}</FormSuccess>
      <input type="hidden" name="visitId" value={visitId} />
      <input type="hidden" name="studentId" value={studentId} />
      <SelectField
        label={t('correction.status')}
        name="status"
        value={status}
        onChange={(event) => setStatus(event.target.value)}
        options={(['PRESENT', 'LATE', 'ABSENT'] as const).map((s) => ({
          value: s,
          label: t(`status.${s}`),
        }))}
        errors={state.fieldErrors?.status}
      />
      {status === 'LATE' && (
        <Field
          label={t('correction.minutesLate')}
          name="minutesLate"
          inputMode="numeric"
          dir="ltr"
          required
          defaultValue={
            state.values?.minutesLate ??
            (current?.status === 'LATE' ? String(current.minutesLate) : '')
          }
          errors={state.fieldErrors?.minutesLate}
        />
      )}
      <TextAreaField
        label={t('correction.reason')}
        name="reason"
        maxLength={500}
        hint={t('correction.reasonHint')}
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton variant="secondary">{t('correction.save')}</SubmitButton>
    </form>
  );
}
