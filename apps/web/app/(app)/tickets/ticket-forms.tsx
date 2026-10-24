'use client';

import {
  type SwapTargetsResponse,
  TICKET_CATEGORIES,
  TICKET_FILE_TYPES,
  TICKET_STATUSES,
  type TicketCategory,
  type TicketStatus,
} from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState, useId, useState } from 'react';
import {
  CheckboxField,
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import { replyAction, setTicketStatusAction, submitRequestAction } from './actions';

const ACCEPT = TICKET_FILE_TYPES.join(',');

interface Requester {
  fullName: string;
  seatNumber: string;
}

/**
 * The student's request form (§13.1, §14.1): one clear category choice, and
 * fields that follow it. The requester's own details are shown, never re-typed.
 */
export function NewRequestForm({
  requester,
  swap,
}: {
  requester: Requester;
  /** Null when the groups could not be loaded. */
  swap: SwapTargetsResponse | null;
}) {
  const t = useTranslations('tickets');
  const [state, action] = useActionState(submitRequestAction, IDLE);
  const [category, setCategory] = useState<TicketCategory>(
    (TICKET_CATEGORIES as readonly string[]).includes(state.values?.category ?? '')
      ? (state.values?.category as TicketCategory)
      : 'COMPLAINT',
  );
  const id = useId();
  const value = (name: string) => state.values?.[name] ?? '';
  const err = (name: string) => state.fieldErrors?.[name];
  const isSwap = category === 'GROUP_SWAP';
  const canSwap = swap !== null && swap.current !== null && swap.targets.length > 0;

  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <fieldset className="choice-list">
        <legend>{t('fields.category')}</legend>
        {TICKET_CATEGORIES.map((c) => (
          <div key={c} className="choice">
            <input
              id={`${id}-${c}`}
              type="radio"
              name="category"
              value={c}
              // Uncontrolled: React resets forms after an action, to these defaults.
              defaultChecked={category === c}
              onChange={() => setCategory(c)}
              aria-describedby={`${id}-${c}-hint`}
            />
            <label htmlFor={`${id}-${c}`}>
              <strong>{t(`categories.${c}`)}</strong>
              <span className="muted small" id={`${id}-${c}-hint`}>
                {t(`categoryHints.${c}`)}
              </span>
            </label>
          </div>
        ))}
      </fieldset>

      <dl className="details">
        <div>
          <dt>{t('fields.requester')}</dt>
          <dd>{requester.fullName}</dd>
        </div>
        <div>
          <dt>{t('fields.seatNumber')}</dt>
          <dd dir="ltr">{requester.seatNumber}</dd>
        </div>
        {isSwap && swap && (
          <div>
            <dt>{t('swap.currentGroup')}</dt>
            <dd>{swap.current?.name ?? t('swap.noGroupShort')}</dd>
          </div>
        )}
      </dl>

      {!isSwap && (
        <>
          <Field
            label={t('fields.subject')}
            name="subject"
            required
            maxLength={200}
            defaultValue={value('subject')}
            errors={err('subject')}
          />
          <TextAreaField
            label={t('fields.description')}
            name="description"
            required
            rows={6}
            maxLength={5000}
            defaultValue={value('description')}
            errors={err('description')}
          />
          <Field
            label={t('fields.files')}
            name="files"
            type="file"
            multiple
            accept={ACCEPT}
            hint={t('filesHint')}
            errors={err('files')}
          />
          <SubmitButton>{t('submit')}</SubmitButton>
        </>
      )}

      {isSwap && swap === null && <p className="alert alert-error">{t('swap.unavailable')}</p>}
      {isSwap && swap && swap.current === null && (
        <p className="alert alert-info">{t('swap.noGroup')}</p>
      )}
      {isSwap && swap && swap.current !== null && swap.targets.length === 0 && (
        <p className="alert alert-info">{t('swap.noTargets')}</p>
      )}
      {isSwap && canSwap && (
        <>
          <p className="muted small">{t('swap.explain')}</p>
          <SelectField
            label={t('swap.targetGroup')}
            name="targetGroupId"
            required
            defaultValue={value('targetGroupId')}
            errors={err('targetGroupId')}
            options={[
              { value: '', label: t('swap.chooseGroup') },
              ...swap.targets.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
          <Field
            label={t('swap.counterpartSeat')}
            name="counterpartSeatNumber"
            required
            inputMode="numeric"
            autoComplete="off"
            dir="ltr"
            maxLength={20}
            defaultValue={value('counterpartSeatNumber')}
            hint={t('swap.counterpartSeatHint')}
            errors={err('counterpartSeatNumber')}
          />
          <Field
            label={t('swap.counterpartName')}
            name="counterpartName"
            autoComplete="off"
            maxLength={200}
            defaultValue={value('counterpartName')}
            hint={t('swap.counterpartNameHint')}
            errors={err('counterpartName')}
          />
          <TextAreaField
            label={t('swap.note')}
            name="note"
            maxLength={1000}
            defaultValue={value('note')}
            errors={err('note')}
          />
          <SubmitButton>{t('swap.submit')}</SubmitButton>
        </>
      )}
    </form>
  );
}

/** A reply, with files; staff may keep it as an internal note (§13.4). */
export function ReplyForm({ id, staff }: { id: string; staff: boolean }) {
  const t = useTranslations('tickets');
  const [state, action] = useActionState(replyAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('replySent')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <TextAreaField
        label={t('fields.reply')}
        name="body"
        required
        rows={4}
        maxLength={5000}
        defaultValue={state.status === 'error' ? (state.values?.body ?? '') : ''}
        errors={state.fieldErrors?.body}
      />
      <Field
        label={t('fields.files')}
        name="files"
        type="file"
        multiple
        accept={ACCEPT}
        hint={t('filesHint')}
        errors={state.fieldErrors?.files}
      />
      {staff && (
        <CheckboxField
          label={t('internalNote')}
          name="internal"
          defaultChecked={state.status === 'error' && state.values?.internal === 'true'}
          hint={t('internalNoteHint')}
        />
      )}
      <SubmitButton>{t('sendReply')}</SubmitButton>
    </form>
  );
}

/** Staff: move a ticket on, with the outcome shown to the student (§13.4). */
export function StatusForm({ id, status }: { id: string; status: TicketStatus }) {
  const t = useTranslations('tickets');
  const [state, action] = useActionState(setTicketStatusAction, IDLE);
  const choices = TICKET_STATUSES.filter((s) => s !== status);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('statusSaved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <SelectField
        label={t('fields.newStatus')}
        name="status"
        defaultValue={state.values?.status ?? choices[0]}
        options={choices.map((s) => ({ value: s, label: t(`status.${s}`) }))}
      />
      <TextAreaField
        label={t('fields.outcome')}
        name="note"
        maxLength={1000}
        hint={t('outcomeHint')}
        defaultValue={state.status === 'error' ? (state.values?.note ?? '') : ''}
        errors={state.fieldErrors?.note}
      />
      <SubmitButton variant="secondary">{t('updateStatus')}</SubmitButton>
    </form>
  );
}
