'use client';

import {
  type CheckInPolicy,
  type GroupRef,
  type Program,
  type Schedule,
  SUGGESTED_PROGRAM_SETTINGS,
  type VisitTiming,
} from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
} from '@/components/form-controls';
import { GroupPicker } from '@/components/group-picker';
import { type FormState, IDLE } from '@/lib/forms';
import {
  createExceptionAction,
  createProgramAction,
  createScheduleAction,
  endScheduleAction,
  removeExceptionAction,
  updateAttendanceDefaultsAction,
  updateProgramPlanAction,
  updateScheduleAction,
} from './actions';

const val = (state: FormState, name: string, fallback: string | number | null | undefined) =>
  state.values?.[name] ?? (fallback === null || fallback === undefined ? '' : String(fallback));

function TimingFields({ state, timing }: { state: FormState; timing: VisitTiming }) {
  const t = useTranslations('schedule.fields');
  return (
    <div className="grid-2">
      <Field
        label={t('opens')}
        name="checkInOpensMinutes"
        inputMode="numeric"
        dir="ltr"
        required
        defaultValue={val(state, 'checkInOpensMinutes', timing.checkInOpensMinutes)}
        errors={state.fieldErrors?.checkInOpensMinutes}
      />
      <Field
        label={t('grace')}
        name="graceMinutes"
        inputMode="numeric"
        dir="ltr"
        required
        defaultValue={val(state, 'graceMinutes', timing.graceMinutes)}
        errors={state.fieldErrors?.graceMinutes}
      />
      <Field
        label={t('closes')}
        name="checkInClosesMinutes"
        inputMode="numeric"
        dir="ltr"
        required
        defaultValue={val(state, 'checkInClosesMinutes', timing.checkInClosesMinutes)}
        errors={state.fieldErrors?.checkInClosesMinutes}
      />
    </div>
  );
}

/**
 * §7.2 as revised in Phase 8: every check-in sends the device location; the
 * program may limit the distance from the visit and the reading's accuracy.
 * Empty means no limit. Biometrics are never part of attendance.
 */
function PolicyFields({ state, policy }: { state: FormState; policy: CheckInPolicy }) {
  const t = useTranslations('schedule.policy');
  return (
    <fieldset className="plain-fieldset stack">
      <legend>{t('title')}</legend>
      <p className="muted small">{t('intro')}</p>
      <div className="grid-2">
        <Field
          label={t('radius')}
          name="radiusMeters"
          inputMode="numeric"
          dir="ltr"
          hint={t('radiusHint')}
          defaultValue={val(state, 'radiusMeters', policy.radiusMeters)}
          errors={state.fieldErrors?.radiusMeters}
        />
        <Field
          label={t('accuracy')}
          name="maxAccuracyMeters"
          inputMode="numeric"
          dir="ltr"
          hint={t('accuracyHint')}
          defaultValue={val(state, 'maxAccuracyMeters', policy.maxAccuracyMeters)}
          errors={state.fieldErrors?.maxAccuracyMeters}
        />
      </div>
    </fieldset>
  );
}

function PlanFields({ state, program }: { state: FormState; program?: Program }) {
  const t = useTranslations('schedule.fields');
  return (
    <div className="grid-2">
      <Field
        label={t('name')}
        name="name"
        required
        defaultValue={val(state, 'name', program?.name)}
        errors={state.fieldErrors?.name}
      />
      <Field
        label={t('startDate')}
        name="startDate"
        type="date"
        required
        defaultValue={val(state, 'startDate', program?.startDate)}
        errors={state.fieldErrors?.startDate}
      />
      <Field
        label={t('durationWeeks')}
        name="durationWeeks"
        inputMode="numeric"
        dir="ltr"
        required
        defaultValue={val(
          state,
          'durationWeeks',
          program?.durationWeeks ?? SUGGESTED_PROGRAM_SETTINGS.durationWeeks,
        )}
        errors={state.fieldErrors?.durationWeeks}
      />
    </div>
  );
}

/** First configuration, pre-filled with suggested values the Director can change. */
export function CreateProgramForm() {
  const t = useTranslations('schedule');
  const [state, action] = useActionState(createProgramAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <p className="muted small">{t('program.suggestedHint')}</p>
      <PlanFields state={state} />
      <Field
        label={t('fields.allowedAbsences')}
        name="allowedAbsences"
        inputMode="numeric"
        dir="ltr"
        required
        defaultValue={val(state, 'allowedAbsences', SUGGESTED_PROGRAM_SETTINGS.allowedAbsences)}
        errors={state.fieldErrors?.allowedAbsences}
      />
      <TimingFields state={state} timing={SUGGESTED_PROGRAM_SETTINGS.timing} />
      <PolicyFields state={state} policy={SUGGESTED_PROGRAM_SETTINGS.checkInPolicy} />
      <SubmitButton>{t('program.create')}</SubmitButton>
    </form>
  );
}

export function ProgramPlanForm({ program }: { program: Program }) {
  const t = useTranslations('schedule');
  const [state, action] = useActionState(updateProgramPlanAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('saved')}</FormSuccess>
      <PlanFields state={state} program={program} />
      <p className="muted small">{t('program.planHint')}</p>
      <Field label={t('fields.reason')} name="reason" defaultValue={val(state, 'reason', '')} />
      <SubmitButton variant="secondary">{t('save')}</SubmitButton>
    </form>
  );
}

export function AttendanceDefaultsForm({ program }: { program: Program }) {
  const t = useTranslations('schedule');
  const [state, action] = useActionState(updateAttendanceDefaultsAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('saved')}</FormSuccess>
      <Field
        label={t('fields.allowedAbsences')}
        name="allowedAbsences"
        inputMode="numeric"
        dir="ltr"
        required
        defaultValue={val(state, 'allowedAbsences', program.allowedAbsences)}
        errors={state.fieldErrors?.allowedAbsences}
      />
      <TimingFields state={state} timing={program.timing} />
      <p className="alert alert-info">{t('program.defaultsHint')}</p>
      <PolicyFields state={state} policy={program.checkInPolicy} />
      <Field label={t('fields.reason')} name="reason" defaultValue={val(state, 'reason', '')} />
      <SubmitButton variant="secondary">{t('save')}</SubmitButton>
    </form>
  );
}

/** Weekday checkboxes in the Egyptian week order (Saturday first). */
function WeekdayPicker({
  names,
  selected,
  errors,
}: {
  names: { day: number; label: string }[];
  selected: number[];
  errors?: string[];
}) {
  const t = useTranslations('schedule.fields');
  const te = useTranslations('errors');
  return (
    <fieldset className={`field${errors?.length ? ' field-invalid' : ''}`}>
      <legend>{t('weekdays')}</legend>
      <ul className="check-list check-list-inline">
        {names.map(({ day, label }) => (
          <li key={day}>
            <label>
              <input
                type="checkbox"
                name="weekdays"
                value={day}
                defaultChecked={selected.includes(day)}
              />
              {label}
            </label>
          </li>
        ))}
      </ul>
      {errors && errors.length > 0 && (
        <ul className="field-errors">
          {errors.map((c) => (
            <li key={c}>{te.has(c) ? te(c) : te('field')}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

interface ScheduleFormProps {
  groups: GroupRef[];
  weekdayNames: { day: number; label: string }[];
  program: Program;
  schedule?: Schedule;
}

export function ScheduleForm({ groups, weekdayNames, program, schedule }: ScheduleFormProps) {
  const t = useTranslations('schedule');
  const [state, action] = useActionState(
    schedule ? updateScheduleAction : createScheduleAction,
    IDLE,
  );
  const listOr = (name: string, fallback: string[]) =>
    state.values?.[name] !== undefined ? state.values[name].split(',').filter(Boolean) : fallback;
  const weekdays = listOr('weekdays', (schedule?.weekdays ?? []).map(String)).map(Number);
  const selectedGroups = listOr('groupIds', schedule?.groups.map((g) => g.id) ?? []);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>
        {t(schedule ? 'scheduleSaved' : 'scheduleCreated', {
          created: Number(state.values?.created ?? 0),
          updated: Number(state.values?.updated ?? 0),
          removed: Number(state.values?.removed ?? 0),
        })}
      </FormSuccess>
      {schedule && <input type="hidden" name="id" value={schedule.id} />}
      <Field
        label={t('fields.title')}
        name="title"
        required
        defaultValue={val(state, 'title', schedule?.title)}
        errors={state.fieldErrors?.title}
      />
      <WeekdayPicker
        names={weekdayNames}
        selected={weekdays}
        errors={state.fieldErrors?.weekdays}
      />
      <div className="grid-2">
        <Field
          label={t('fields.startTime')}
          name="startTime"
          type="time"
          required
          defaultValue={val(state, 'startTime', schedule?.startTime)}
          errors={state.fieldErrors?.startTime}
        />
        <Field
          label={t('fields.endTime')}
          name="endTime"
          type="time"
          defaultValue={val(state, 'endTime', schedule?.endTime)}
          errors={state.fieldErrors?.endTime}
        />
        {!schedule && (
          <Field
            label={t('fields.startsOn')}
            name="startsOn"
            type="date"
            hint={t('fields.startsOnHint', { date: program.startDate })}
            defaultValue={val(state, 'startsOn', '')}
            errors={state.fieldErrors?.startsOn}
          />
        )}
        <Field
          label={t('fields.endsOn')}
          name="endsOn"
          type="date"
          required={schedule !== undefined}
          hint={schedule ? undefined : t('fields.endsOnHint', { date: program.endDate })}
          defaultValue={val(state, 'endsOn', schedule?.endsOn)}
          errors={state.fieldErrors?.endsOn}
        />
      </div>
      <Field
        label={t('fields.locationName')}
        name="locationName"
        defaultValue={val(state, 'locationName', schedule?.locationName)}
        errors={state.fieldErrors?.locationName}
      />
      <GroupPicker
        groups={groups}
        selected={selectedGroups}
        label={t('fields.groups')}
        hint={t('fields.groupsHint')}
        errors={state.fieldErrors?.groupIds}
      />
      {schedule && (
        <>
          <p className="alert alert-info">{t('editHint')}</p>
          <Field label={t('fields.reason')} name="reason" defaultValue={val(state, 'reason', '')} />
        </>
      )}
      <SubmitButton>{schedule ? t('save') : t('createSchedule')}</SubmitButton>
    </form>
  );
}

export function EndScheduleForm({ id }: { id: string }) {
  const t = useTranslations('schedule');
  const [state, action] = useActionState(endScheduleAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      <p className="muted small">{t('endHint')}</p>
      <Field
        label={t('fields.endReason')}
        name="reason"
        required
        defaultValue={val(state, 'reason', '')}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton variant="danger" confirm={t('endConfirm')}>
        {t('end')}
      </SubmitButton>
    </form>
  );
}

export function ExceptionForm({
  schedules,
  allowAll,
}: {
  schedules: { id: string; title: string }[];
  allowAll: boolean;
}) {
  const t = useTranslations('schedule');
  const [state, action] = useActionState(createExceptionAction, IDLE);
  const options = [
    ...(allowAll ? [{ value: '', label: t('exceptions.allSchedules') }] : []),
    ...schedules.map((s) => ({ value: s.id, label: s.title })),
  ];
  return (
    <form action={action} className="stack" noValidate>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>
        {t('exceptions.added', {
          affected: Number(state.values?.affected ?? 0),
          notified: Number(state.values?.notified ?? 0),
        })}
      </FormSuccess>
      <div className="grid-2">
        <Field
          label={t('fields.date')}
          name="date"
          type="date"
          required
          defaultValue={val(state, 'date', '')}
          errors={state.fieldErrors?.date}
        />
        <SelectField
          label={t('exceptions.appliesTo')}
          name="scheduleId"
          options={options}
          defaultValue={val(state, 'scheduleId', options[0]?.value)}
        />
      </div>
      <Field
        label={t('fields.exceptionReason')}
        name="reason"
        required
        defaultValue={val(state, 'reason', '')}
        errors={state.fieldErrors?.reason}
      />
      <SubmitButton>{t('exceptions.add')}</SubmitButton>
    </form>
  );
}

export function RemoveExceptionButton({ id }: { id: string }) {
  const t = useTranslations('schedule.exceptions');
  const [state, action] = useActionState(removeExceptionAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" confirm={t('removeConfirm')}>
        {t('remove')}
      </SubmitButton>
      {state.status === 'error' && <FormError state={state} />}
    </form>
  );
}
