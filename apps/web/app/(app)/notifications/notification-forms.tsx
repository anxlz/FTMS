'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { FormError, SubmitButton } from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { markAllReadAction, markReadAction } from './actions';

export function MarkAllReadButton() {
  const t = useTranslations('notifications');
  const [state, action] = useActionState(markAllReadAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <SubmitButton variant="secondary">{t('markAllRead')}</SubmitButton>
      {state.status === 'error' && <FormError state={state} />}
    </form>
  );
}

export function MarkReadButton({ id }: { id: string }) {
  const t = useTranslations('notifications');
  const [state, action] = useActionState(markReadAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary">{t('markRead')}</SubmitButton>
      {state.status === 'error' && <FormError state={state} />}
    </form>
  );
}
