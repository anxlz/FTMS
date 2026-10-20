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
import { IDLE } from '@/lib/forms';
import { deleteStudentAction, setStudentGroupAction, unlinkAccountAction } from '../actions';

export function GroupForm({
  id,
  current,
  groups,
}: {
  id: string;
  current: string | null;
  groups: Group[];
}) {
  const t = useTranslations('students');
  const [state, action] = useActionState(setStudentGroupAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('detail.groupSaved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <SelectField
        label={t('fields.group')}
        name="groupId"
        defaultValue={state.values?.groupId ?? current ?? ''}
        options={[
          { value: '', label: t('fields.noGroup') },
          ...groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
        hint={t('detail.groupHint')}
      />
      <Field
        label={t('fields.reason')}
        name="reason"
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton variant="secondary">{t('detail.saveGroup')}</SubmitButton>
    </form>
  );
}

/** Destructive actions: a reason is required and a confirmation is asked (§18.3). */
export function DangerForm({ id, kind }: { id: string; kind: 'delete' | 'unlink' }) {
  const t = useTranslations('students');
  const [state, action] = useActionState(
    kind === 'delete' ? deleteStudentAction : unlinkAccountAction,
    IDLE,
  );
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('detail.unlinked')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <p className="muted small">
        {kind === 'delete' ? t('detail.deleteHint') : t('detail.unlinkHint')}
      </p>
      <Field
        label={t('fields.reasonRequired')}
        name="reason"
        required
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton
        variant="danger"
        confirm={kind === 'delete' ? t('detail.deleteConfirm') : t('detail.unlinkConfirm')}
      >
        {kind === 'delete' ? t('detail.delete') : t('detail.unlink')}
      </SubmitButton>
    </form>
  );
}
