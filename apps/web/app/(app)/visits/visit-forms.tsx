'use client';

import {
  type GroupRef,
  VISIT_DOCUMENT_TYPES,
  VISIT_IMAGE_TYPES,
  type VisitDetail,
  type VisitTiming,
} from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form-controls';
import { GroupPicker } from '@/components/group-picker';
import { IDLE } from '@/lib/forms';
import {
  cancelVisitAction,
  createVisitAction,
  removeVisitFileAction,
  restoreVisitAction,
  updateVisitAction,
  uploadVisitFileAction,
} from './actions';

interface VisitFormProps {
  groups: GroupRef[];
  /** Program defaults, shown next to the timing choice. */
  defaults: VisitTiming;
  canOverrideTiming: boolean;
  /** Edit mode: the visit as it is. */
  visit?: VisitDetail;
}

/**
 * Create or edit a visit (§6.3). Once check-in has opened, date, time, groups
 * and timing are shown but disabled — the API refuses those changes anyway.
 */
export function VisitForm({ groups, defaults, canOverrideTiming, visit }: VisitFormProps) {
  const t = useTranslations('visits');
  const [state, action] = useActionState(visit ? updateVisitAction : createVisitAction, IDLE);
  const id = useId();
  const locked = visit !== undefined && visit.phase !== 'UPCOMING';
  const value = (name: string, fallback: string | number | null | undefined = '') =>
    state.values?.[name] ?? (fallback === null ? '' : String(fallback));
  const err = (name: string) => state.fieldErrors?.[name];
  const timing = visit?.timing ?? defaults;
  const selected = state.values?.groupIds
    ? state.values.groupIds.split(',').filter(Boolean)
    : (visit?.groups.map((g) => g.id) ?? []);
  // Archived groups a visit still targets stay listed so they can be removed.
  const options = [
    ...groups,
    ...(visit?.groups ?? []).filter((g) => !groups.some((o) => o.id === g.id)),
  ];

  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      {visit && <input type="hidden" name="id" value={visit.id} />}
      <Field
        label={t('fields.title')}
        name="title"
        required
        maxLength={200}
        defaultValue={value('title', visit?.title)}
        errors={err('title')}
      />
      <TextAreaField
        label={t('fields.description')}
        name="description"
        maxLength={5000}
        defaultValue={value('description', visit?.description)}
        errors={err('description')}
      />

      {locked && <p className="alert alert-info">{t('lockedNote')}</p>}
      <fieldset className="stack plain-fieldset" disabled={locked}>
        <legend className="sr-only">{t('fields.when')}</legend>
        <div className="grid-2">
          <Field
            label={t('fields.date')}
            name="date"
            type="date"
            required
            defaultValue={value('date', visit?.date)}
            errors={err('date')}
          />
          <Field
            label={t('fields.startTime')}
            name="startTime"
            type="time"
            required
            defaultValue={value('startTime', visit?.startTime)}
            errors={err('startTime')}
          />
          <Field
            label={t('fields.endTime')}
            name="endTime"
            type="time"
            hint={t('fields.optional')}
            defaultValue={value('endTime', visit?.endTime)}
            errors={err('endTime')}
          />
        </div>
        {!locked && <input type="hidden" name="groupsEditable" value="1" />}
        <GroupPicker
          groups={options}
          selected={selected}
          label={t('fields.groups')}
          hint={t('fields.groupsHint')}
          errors={err('groupIds')}
        />
      </fieldset>

      <fieldset className="stack plain-fieldset">
        <legend className="h2">{t('fields.location')}</legend>
        <Field
          label={t('fields.locationName')}
          name="locationName"
          maxLength={200}
          defaultValue={value('locationName', visit?.locationName)}
          errors={err('name') ?? err('locationName')}
        />
        <div className="grid-2">
          <Field
            label={t('fields.latitude')}
            name="latitude"
            inputMode="decimal"
            dir="ltr"
            defaultValue={value('latitude', visit?.latitude)}
            errors={err('latitude')}
          />
          <Field
            label={t('fields.longitude')}
            name="longitude"
            inputMode="decimal"
            dir="ltr"
            defaultValue={value('longitude', visit?.longitude)}
            errors={err('longitude')}
          />
        </div>
        <Field
          label={t('fields.mapUrl')}
          name="mapUrl"
          type="url"
          dir="ltr"
          hint={t('fields.mapUrlHint')}
          defaultValue={value('mapUrl', visit?.mapUrl)}
          errors={err('mapUrl')}
        />
      </fieldset>

      {canOverrideTiming ? (
        <fieldset className="stack plain-fieldset" disabled={locked}>
          <legend className="h2">{t('fields.timing')}</legend>
          <p className="muted small">
            {t('fields.timingDefaults', {
              opens: defaults.checkInOpensMinutes,
              grace: defaults.graceMinutes,
              closes: defaults.checkInClosesMinutes,
            })}
          </p>
          <SelectField
            label={t('fields.timingMode')}
            name="timingMode"
            defaultValue={value('timingMode', visit ? 'keep' : 'defaults')}
            options={[
              ...(visit ? [{ value: 'keep', label: t('fields.timingKeep') }] : []),
              { value: 'defaults', label: t('fields.timingUseDefaults') },
              { value: 'custom', label: t('fields.timingCustom') },
            ]}
          />
          <div className="grid-2" id={`${id}-timing`}>
            <Field
              label={t('fields.opens')}
              name="checkInOpensMinutes"
              inputMode="numeric"
              dir="ltr"
              defaultValue={value('checkInOpensMinutes', timing.checkInOpensMinutes)}
              errors={err('checkInOpensMinutes')}
            />
            <Field
              label={t('fields.grace')}
              name="graceMinutes"
              inputMode="numeric"
              dir="ltr"
              defaultValue={value('graceMinutes', timing.graceMinutes)}
              errors={err('graceMinutes')}
            />
            <Field
              label={t('fields.closes')}
              name="checkInClosesMinutes"
              inputMode="numeric"
              dir="ltr"
              defaultValue={value('checkInClosesMinutes', timing.checkInClosesMinutes)}
              errors={err('checkInClosesMinutes')}
            />
          </div>
        </fieldset>
      ) : (
        <p className="muted small">
          {t('fields.timingFixed', {
            opens: timing.checkInOpensMinutes,
            grace: timing.graceMinutes,
            closes: timing.checkInClosesMinutes,
          })}
        </p>
      )}

      {visit && (
        <Field
          label={t('fields.reason')}
          name="reason"
          hint={t('fields.reasonHint')}
          defaultValue={value('reason')}
          errors={err('reason')}
        />
      )}
      <SubmitButton>{visit ? t('save') : t('create')}</SubmitButton>
    </form>
  );
}

export function CancelVisitForm({ id }: { id: string }) {
  const t = useTranslations('visits');
  const [state, action] = useActionState(cancelVisitAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      <Field
        label={t('fields.cancelReason')}
        name="reason"
        required
        defaultValue={state.values?.reason}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton variant="danger" confirm={t('cancelConfirm')}>
        {t('cancel')}
      </SubmitButton>
    </form>
  );
}

export function RestoreVisitForm({ id }: { id: string }) {
  const t = useTranslations('visits');
  const [state, action] = useActionState(restoreVisitAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary">{t('restore')}</SubmitButton>
    </form>
  );
}

export function UploadFileForm({ id }: { id: string }) {
  const t = useTranslations('visits.files');
  const [state, action] = useActionState(uploadVisitFileAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('uploaded')}</FormSuccess>
      <input type="hidden" name="id" value={id} />
      <SelectField
        label={t('kind')}
        name="kind"
        defaultValue="DOCUMENT"
        options={[
          { value: 'DOCUMENT', label: t('kinds.DOCUMENT') },
          { value: 'COVER', label: t('kinds.COVER') },
        ]}
      />
      <Field
        label={t('file')}
        name="file"
        type="file"
        accept={[...new Set([...VISIT_DOCUMENT_TYPES, ...VISIT_IMAGE_TYPES])].join(',')}
        hint={t('hint')}
        errors={state.fieldErrors?.file}
      />
      <SubmitButton variant="secondary">{t('upload')}</SubmitButton>
    </form>
  );
}

export function RemoveFileButton({
  id,
  fileId,
  name,
}: {
  id: string;
  fileId: string;
  name: string;
}) {
  const t = useTranslations('visits.files');
  const [state, action] = useActionState(removeVisitFileAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="fileId" value={fileId} />
      <SubmitButton variant="secondary" confirm={t('removeConfirm', { name })}>
        {t('remove')}
      </SubmitButton>
      {state.status === 'error' && <FormError state={state} />}
    </form>
  );
}
