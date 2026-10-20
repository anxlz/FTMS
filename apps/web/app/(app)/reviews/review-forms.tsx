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
  TextAreaField,
} from '@/components/form-controls';
import { type FormState, IDLE } from '@/lib/forms';
import {
  approveProfileChangeAction,
  approveVerificationAction,
  rejectProfileChangeAction,
  rejectVerificationAction,
} from './actions';

type Action = (state: FormState, data: FormData) => Promise<FormState>;

/** Approve (optional comment) and reject (mandatory reason) side by side. */
export function DecisionForms({
  id,
  kind,
  groups,
}: {
  id: string;
  kind: 'profileChange' | 'verification';
  /** Verification only: groups for a newly created record (null without groups.manage). */
  groups?: Group[] | null;
}) {
  const t = useTranslations('reviews');
  const approveAction: Action =
    kind === 'profileChange' ? approveProfileChangeAction : approveVerificationAction;
  const rejectAction: Action =
    kind === 'profileChange' ? rejectProfileChangeAction : rejectVerificationAction;
  const [approved, approve] = useActionState(approveAction, IDLE);
  const [rejected, reject] = useActionState(rejectAction, IDLE);
  return (
    <div className="grid-2">
      <form action={approve} className="stack" noValidate>
        <h3>{kind === 'profileChange' ? t('approveTitle') : t('verification.createTitle')}</h3>
        {kind === 'verification' && <p className="muted small">{t('verification.createHint')}</p>}
        <FormError state={approved} />
        <FormSuccess show={approved.status === 'success'}>{t('decided')}</FormSuccess>
        <input type="hidden" name="id" value={id} />
        {kind === 'verification' && groups && (
          <SelectField
            label={t('verification.group')}
            name="groupId"
            defaultValue=""
            options={[
              { value: '', label: t('verification.noGroup') },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        )}
        <TextAreaField
          label={t('comment')}
          name="comment"
          defaultValue={approved.values?.comment}
        />
        <SubmitButton>
          {kind === 'profileChange' ? t('approve') : t('verification.create')}
        </SubmitButton>
      </form>
      <form action={reject} className="stack" noValidate>
        <h3>{t('rejectTitle')}</h3>
        <FormError state={rejected} />
        <FormSuccess show={rejected.status === 'success'}>{t('decided')}</FormSuccess>
        <input type="hidden" name="id" value={id} />
        <TextAreaField
          label={t('reason')}
          name="reason"
          required
          hint={t('reasonHint')}
          defaultValue={rejected.values?.reason}
          errors={rejected.fieldErrors?.reason}
        />
        <SubmitButton variant="danger" confirm={t('rejectConfirm')}>
          {t('reject')}
        </SubmitButton>
      </form>
    </div>
  );
}

/** Links the waiting account to one candidate record. */
export function LinkCandidateForm({
  id,
  studentId,
  name,
}: {
  id: string;
  studentId: string;
  name: string;
}) {
  const t = useTranslations('reviews.verification');
  const [state, action] = useActionState(approveVerificationAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="studentId" value={studentId} />
      <Field label={t('linkComment')} name="comment" defaultValue={state.values?.comment} />
      <SubmitButton confirm={t('linkConfirm', { name })}>{t('link')}</SubmitButton>
    </form>
  );
}
