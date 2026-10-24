'use client';

import { APP_TIMEZONE, type AttendanceRecord, type CheckInContext } from '@ftms/core';
import { startAuthentication } from '@simplewebauthn/browser';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { FormError } from '@/components/form-controls';
import { useWebAuthnSupport } from '@/lib/use-webauthn';
import { ceremonyErrorCode, type LocationReading, readLocation } from '@/lib/device';
import { type FormState, IDLE } from '@/lib/forms';
import { checkInAction, checkInOptionsAction } from '../actions';

interface Texts {
  date: string;
  time: string;
  opensAt: string;
  onTimeUntil: string;
  closesAt: string;
  serverTime: string;
}

type Step = 'idle' | 'locating' | 'confirming' | 'sending';

/**
 * The student's side of §7.2: one button that reads the device location, asks
 * the device for a fresh biometric confirmation bound to this visit, and sends
 * both. The outcome (present, late, refused) is decided by the server.
 */
export function CheckInPanel({
  token,
  context,
  text,
  enableHref,
}: {
  token: string;
  context: CheckInContext;
  text: Texts;
  enableHref: string;
}) {
  const t = useTranslations('checkIn');
  const ta = useTranslations('attendance');
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<FormState>(IDLE);
  const [step, setStep] = useState<Step>('idle');
  const [record, setRecord] = useState<AttendanceRecord | null>(context.existing);
  const [justRecorded, setJustRecorded] = useState(false);
  const webAuthn = useWebAuthnSupport();
  const [pending, startTransition] = useTransition();

  const clock = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: APP_TIMEZONE, timeStyle: 'short' }).format(
      new Date(iso),
    );
  const { visit, window: w, requirements } = context;
  const biometric = requirements.biometric;
  const locationRequired = requirements.geolocation === 'REQUIRED';

  const submit = () =>
    startTransition(async () => {
      setState(IDLE);
      // 1. The device's location at this moment (§7.2).
      setStep('locating');
      let location: LocationReading | undefined;
      const reading = await readLocation(locationRequired ? 20_000 : 8_000);
      if (reading.ok) location = reading.reading;
      else if (locationRequired) {
        setStep('idle');
        setState({ status: 'error', error: reading.error });
        return;
      }

      // 2. A fresh biometric confirmation for this check-in.
      let confirmation: { challengeId: string; response: unknown } | undefined;
      if (biometric === 'REQUIRED') {
        setStep('confirming');
        const start = await checkInOptionsAction(token);
        if (!start.ok) {
          setStep('idle');
          setState({
            status: 'error',
            error: start.error,
            retryAfterMinutes: start.retryAfterMinutes,
          });
          return;
        }
        try {
          const response = await startAuthentication({
            optionsJSON: start.options as unknown as Parameters<
              typeof startAuthentication
            >[0]['optionsJSON'],
          });
          confirmation = { challengeId: start.challengeId, response };
        } catch (error) {
          setStep('idle');
          setState({ status: 'error', error: ceremonyErrorCode(error) });
          return;
        }
      }

      // 3. The server decides.
      setStep('sending');
      const result = await checkInAction({ token, biometric: confirmation, location });
      setStep('idle');
      if (result.ok) {
        setRecord(result.record);
        setJustRecorded(true);
        return;
      }
      setState({
        status: 'error',
        error: result.error,
        retryAfterMinutes: result.retryAfterMinutes,
      });
      if (result.error === 'ATTENDANCE_ALREADY_RECORDED') router.refresh();
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
            <li>
              {record.biometricVerified ? t('biometricConfirmed') : t('biometricNotConfirmed')}
            </li>
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
          {biometric === 'REQUIRED' && <p className="muted">{t('requiresBiometric')}</p>}
          {biometric === 'NOT_ENROLLED_ALLOWED' && (
            <p className="alert alert-info">
              {t('fallbackAllowed')} <Link href={enableHref}>{t('enableBiometrics')}</Link>
            </p>
          )}
          {biometric === 'NOT_ENROLLED_BLOCKED' && (
            <p className="alert alert-error">
              {t('fallbackBlocked')} <Link href={enableHref}>{t('enableBiometrics')}</Link>
            </p>
          )}
          {biometric === 'REQUIRED' && webAuthn === false && (
            <p className="alert alert-error">{t('noWebAuthn')}</p>
          )}
          <p className="muted small">
            {locationRequired ? t('locationRequired') : t('locationOptional')}
          </p>
          <FormError state={state} />
          {biometric !== 'NOT_ENROLLED_BLOCKED' && (
            <button
              type="button"
              className="btn btn-primary btn-large"
              onClick={submit}
              disabled={pending || (biometric === 'REQUIRED' && webAuthn !== true)}
              aria-busy={pending}
            >
              {step === 'locating'
                ? t('locating')
                : step === 'confirming'
                  ? t('confirming')
                  : step === 'sending'
                    ? t('sending')
                    : biometric === 'REQUIRED'
                      ? t('confirmAndCheckIn')
                      : t('checkIn')}
            </button>
          )}
        </div>
      )}
      <p className="muted small">{t('serverTime', { time: text.serverTime })}</p>
    </div>
  );
}
