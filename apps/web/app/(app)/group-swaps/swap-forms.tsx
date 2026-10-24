'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { FormError, SubmitButton, TextAreaField } from '@/components/form-controls';
import { type FormState, IDLE } from '@/lib/forms';
import {
  acceptSwapAction,
  approveSwapAction,
  declineSwapAction,
  rejectSwapAction,
  withdrawSwapAction,
} from './actions';

type Action = (state: FormState, data: FormData) => Promise<FormState>;

function StepForm({
  id,
  action,
  label,
  variant,
  confirm,
  reason,
}: {
  id: string;
  action: Action;
  label: string;
  variant: 'primary' | 'secondary' | 'danger';
  confirm?: string;
  /** A reason field: its label, and whether it must be filled in. */
  reason?: { label: string; required: boolean; hint?: string };
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <form action={formAction} className="stack" noValidate>
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      {reason && (
        <TextAreaField
          label={reason.label}
          name="reason"
          required={reason.required}
          maxLength={500}
          hint={reason.hint}
          defaultValue={state.values?.reason ?? ''}
          errors={state.fieldErrors?.reason}
        />
      )}
      <SubmitButton variant={variant} confirm={confirm}>
        {label}
      </SubmitButton>
    </form>
  );
}

/** The counterpart's explicit answer (§14.4). */
export function CounterpartForms({ id }: { id: string }) {
  const t = useTranslations('groupSwaps');
  return (
    <div className="stack">
      <StepForm
        id={id}
        action={acceptSwapAction}
        label={t('accept')}
        variant="primary"
        confirm={t('acceptConfirm')}
      />
      <details>
        <summary>{t('decline')}</summary>
        <StepForm
          id={id}
          action={declineSwapAction}
          label={t('declineSubmit')}
          variant="danger"
          reason={{ label: t('optionalReason'), required: false, hint: t('declineHint') }}
        />
      </details>
    </div>
  );
}

/** The requester may take back a request that is still open. */
export function WithdrawForm({ id }: { id: string }) {
  const t = useTranslations('groupSwaps');
  return (
    <details>
      <summary>{t('withdraw')}</summary>
      <StepForm
        id={id}
        action={withdrawSwapAction}
        label={t('withdrawSubmit')}
        variant="danger"
        confirm={t('withdrawConfirm')}
        reason={{ label: t('optionalReason'), required: false }}
      />
    </details>
  );
}

/** Faculty decision (§14.5): approve, or reject with a mandatory reason. */
export function FacultyForms({ id }: { id: string }) {
  const t = useTranslations('groupSwaps');
  return (
    <div className="stack">
      <StepForm
        id={id}
        action={approveSwapAction}
        label={t('approve')}
        variant="primary"
        confirm={t('approveConfirm')}
      />
      <details>
        <summary>{t('reject')}</summary>
        <StepForm
          id={id}
          action={rejectSwapAction}
          label={t('rejectSubmit')}
          variant="danger"
          reason={{ label: t('rejectReason'), required: true, hint: t('rejectHint') }}
        />
      </details>
    </div>
  );
}
