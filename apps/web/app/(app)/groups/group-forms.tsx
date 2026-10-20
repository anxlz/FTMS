'use client';

import { type StudentRecord } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  CheckboxField,
  Field,
  FormError,
  FormSuccess,
  SubmitButton,
  TextAreaField,
} from '@/components/form-controls';
import { IDLE } from '@/lib/forms';
import {
  addMembersAction,
  createGroupAction,
  removeMemberAction,
  setGroupArchivedAction,
  updateGroupAction,
} from './actions';

export function CreateGroupForm() {
  const t = useTranslations('groups');
  const [state, action] = useActionState(createGroupAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <Field
        label={t('name')}
        name="name"
        required
        defaultValue={state.values?.name}
        errors={state.fieldErrors?.name}
      />
      <TextAreaField
        label={t('description')}
        name="description"
        defaultValue={state.values?.description}
        errors={state.fieldErrors?.description}
      />
      <SubmitButton>{t('create')}</SubmitButton>
    </form>
  );
}

export function EditGroupForm({
  id,
  name,
  description,
}: {
  id: string;
  name: string;
  description: string | null;
}) {
  const t = useTranslations('groups');
  const [state, action] = useActionState(updateGroupAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('detail.saved')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <Field
        label={t('name')}
        name="name"
        required
        defaultValue={state.values?.name ?? name}
        errors={state.fieldErrors?.name}
      />
      <TextAreaField
        label={t('description')}
        name="description"
        defaultValue={state.values?.description ?? description ?? ''}
        errors={state.fieldErrors?.description}
      />
      <SubmitButton variant="secondary">{t('detail.save')}</SubmitButton>
    </form>
  );
}

export function ArchiveForm({ id, archived }: { id: string; archived: boolean }) {
  const t = useTranslations('groups.detail');
  const [state, action] = useActionState(setGroupArchivedAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="archived" value={String(!archived)} />
      <p className="muted small">{archived ? t('restoreHint') : t('archiveHint')}</p>
      <SubmitButton variant="secondary" confirm={archived ? undefined : t('archiveConfirm')}>
        {archived ? t('restore') : t('archive')}
      </SubmitButton>
    </form>
  );
}

export function RemoveMemberButton({
  id,
  studentId,
  name,
}: {
  id: string;
  studentId: string;
  name: string;
}) {
  const t = useTranslations('groups.detail');
  const [state, action] = useActionState(removeMemberAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="studentId" value={studentId} />
      <SubmitButton variant="secondary" confirm={t('removeConfirm', { name })}>
        {t('remove')}
      </SubmitButton>
      {state.status === 'error' && <FormError state={state} />}
    </form>
  );
}

/** Pick students (from a search) and add them; moving from another group is explicit. */
export function AddMembersForm({ id, candidates }: { id: string; candidates: StudentRecord[] }) {
  const t = useTranslations('groups.detail');
  const tg = useTranslations('students');
  const [state, action] = useActionState(addMembersAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>
        {t('addedResult', {
          added: Number(state.values?.added ?? 0),
          moved: Number(state.values?.moved ?? 0),
          already: Number(state.values?.already ?? 0),
        })}
      </FormSuccess>
      <input type="hidden" name="id" value={id} />
      {candidates.length === 0 ? (
        <p className="empty">{t('noCandidates')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t('select')}</span>
                  </th>
                  <th scope="col">{tg('columns.seatNumber')}</th>
                  <th scope="col">{tg('columns.name')}</th>
                  <th scope="col">{tg('columns.group')}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="checkbox"
                        name="studentIds"
                        value={s.id}
                        aria-label={t('selectStudent', { name: s.fullName })}
                        disabled={s.group?.id === id}
                      />
                    </td>
                    <td dir="ltr">{s.seatNumber}</td>
                    <td>{s.fullName}</td>
                    <td>{s.group?.name ?? tg('noGroup')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CheckboxField name="moveFromOtherGroup" label={t('move')} hint={t('moveHint')} />
          <Field label={tg('fields.reason')} name="reason" defaultValue={state.values?.reason} />
          <SubmitButton>{t('add')}</SubmitButton>
        </>
      )}
    </form>
  );
}
