'use client';

import { APP_TIMEZONE, type AttendanceRecord, type CheckInContext } from '@ftms/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { FormError } from '@/components/form-controls';
import { LocationHelp, LocationReadout, LocationRule } from '@/components/location-step';
import { type LocationReading } from '@/lib/device';
import { type FormState, IDLE } from '@/lib/forms';
import { readLocation } from '@/lib/native';
import { useRefreshOnResume } from '@/lib/use-refresh-on-resume';
import { checkInAction } from '../actions';

interface Texts {
  date: string;
  time: string;
  opensAt: string;
  onTimeUntil: string;
  closesAt: string;
  serverTime: string;
}

type Step = 'idle' | 'locating' | 'sending';

/**
 * The student's side of §7.2 (revised in Phase 8): one button that reads the
 * device location and sends it with the QR token. No biometric step — biometrics
 * are a sign-in convenience only. The outcome (present, late, refused) is the
 * server's; a scan or a location reading alone records nothing.
 */
export function CheckInPanel({
  token,
  context,
  text,
}: {
  token: string;
  context: CheckInContext;
  text: Texts;
}) {
  const t = useTranslations('checkIn');
  const ta = useTranslations('attendance');
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<FormState>(IDLE);
  const [step, setStep] = useState<Step>('idle');
  const [reading, setReading] = useState<LocationReading | null>(null);
  const [record, setRecord] = useState<AttendanceRecord | null>(context.existing);
  const [justRecorded, setJustRecorded] = useState(false);
  const [pending, startTransition] = useTransition();
  useRefreshOnResume(!record && !pending);

  const clock = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: APP_TIMEZONE, timeStyle: 'short' }).format(
      new Date(iso),
    );
  const { visit, window: w } = context;

  const submit = () =>
    startTransition(async () => {
      setState(IDLE);
      // 1. The device's location at this moment.
      setStep('locating');
      const location = await readLocation(20_000);
      if (!location.ok) {
        setStep('idle');
        setState({ status: 'error', error: location.error });
        return;
      }
      setReading(location.reading);
      // 2. The server decides. No automatic retry: a second attempt is the student's choice,
      //    and the one-record-per-visit rule makes it safe.
      setStep('sending');
      let result;
      try {
        result = await checkInAction({ token, location: location.reading });
      } catch {
        result = { ok: false as const, error: 'NETWORK' };
      }
      setStep('idle');
      if (result.ok) {
        setRecord(result.record);
        setJustRecorded(true);
        return;
      }
      setState({
        status: 'error',
        error: result.error,
        retryAfterMinutes: 'retryAfterMinutes' in result ? result.retryAfterMinutes : undefined,
      });
      if (result.error === 'ATTENDANCE_ALREADY_RECORDED' || result.error === 'NETWORK') {
        router.refresh();
      }
    });

  const header = (
    <div className="stack">
      <h2>{visit.title}</h2>
      <p className="muted">
        {text.date} · <span dir="ltr">{text.time}</span>
        {visit.locationName ? ` · ${visit.locationName}` : ''}
      </p>
    </div>
  );

  if (record) {
    return (
      <div className="stack">
        {header}
        <div
          className={`check-in-result check-in-${record.status.toLowerCase()}`}
          role="status"
          aria-live="polite"
        >
          <p className="check-in-status">{justRecorded ? t('recorded') : t('alreadyRecorded')}</p>
          <p className="check-in-verdict">
            {record.status === 'LATE'
              ? ta('lateBy', { minutes: record.minutesLate })
              : ta(`status.${record.status}`)}
          </p>
          {record.checkedInAt && (
            <p className="small">{t('at', { time: clock(record.checkedInAt) })}</p>
          )}
          <ul className="small check-in-facts">
            {record.source === 'GUEST' && <li>{t('viaGuest')}</li>}
            {record.location && <li>{t('locationShared')}</li>}
            {record.correction && <li>{t('corrected')}</li>}
          </ul>
        </div>
        <p>
          <Link href="/attendance">{t('myAttendance')}</Link>
        </p>
      </div>
    );
  }

  if (visit.status === 'CANCELLED') {
    return (
      <div className="stack">
        {header}
        <p className="alert alert-error">{t('cancelled')}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      <dl className="details">
        <div>
          <dt>{t('opens')}</dt>
          <dd>{text.opensAt}</dd>
        </div>
        <div>
          <dt>{t('onTimeUntil')}</dt>
          <dd>{text.onTimeUntil}</dd>
        </div>
        <div>
          <dt>{t('closes')}</dt>
          <dd>{text.closesAt}</dd>
        </div>
      </dl>

      {w.state === 'NOT_OPEN' && (
        <div className="stack">
          <p className="alert alert-info">{t('notOpen', { time: text.opensAt })}</p>
          <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>
            {t('refresh')}
          </button>
        </div>
      )}
      {w.state === 'CLOSED' && <p className="alert alert-error">{t('closed')}</p>}

      {w.state === 'OPEN' && (
        <div className="stack">
          <LocationRule rule={context.location} />
          {reading && <LocationReadout reading={reading} />}
          <FormError state={state} />
          {state.status === 'error' && state.error && <LocationHelp code={state.error} />}
          <button
            type="button"
            className="btn btn-primary btn-large"
            onClick={submit}
            disabled={pending}
            aria-busy={pending}
          >
            {step === 'locating'
              ? t('locating')
              : step === 'sending'
                ? t('sending')
                : state.status === 'error'
                  ? t('tryAgain')
                  : t('checkIn')}
          </button>
        </div>
      )}
      <p className="muted small">{t('serverTime', { time: text.serverTime })}</p>
    </div>
  );
}
