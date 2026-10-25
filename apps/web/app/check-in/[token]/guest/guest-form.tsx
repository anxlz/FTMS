'use client';

import { APP_TIMEZONE, type GuestCheckInContext, type GuestCheckInResult } from '@ftms/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { Field, FormError } from '@/components/form-controls';
import { LocationHelp, LocationReadout, LocationRule } from '@/components/location-step';
import { type LocationReading } from '@/lib/device';
import { type FormState, IDLE } from '@/lib/forms';
import { readLocation } from '@/lib/native';
import { useRefreshOnResume } from '@/lib/use-refresh-on-resume';
import { guestCheckInAction } from '../../guest-actions';

interface Texts {
  date: string;
  time: string;
  opensAt: string;
  onTimeUntil: string;
  closesAt: string;
  serverTime: string;
}

type Step = 'idle' | 'locating' | 'sending';

/** One key per page: a retry after a lost connection is recognized by the server. */
const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null;

/**
 * The guest form (Phase 8): typed full name and seat number — not verified — and
 * the device location. One button reads the location, then sends; the receipt
 * shown afterwards is the server's answer, never a local guess.
 */
export function GuestCheckInForm({
  token,
  context,
  text,
}: {
  token: string;
  context: GuestCheckInContext;
  text: Texts;
}) {
  const t = useTranslations('guest');
  const tc = useTranslations('checkIn');
  const ta = useTranslations('attendance');
  const locale = useLocale();
  const router = useRouter();
  const [submissionKey] = useState(newKey);
  const [fullName, setFullName] = useState('');
  const [seatNumber, setSeatNumber] = useState('');
  const [state, setState] = useState<FormState>(IDLE);
  const [step, setStep] = useState<Step>('idle');
  const [reading, setReading] = useState<LocationReading | null>(null);
  const [receipt, setReceipt] = useState<GuestCheckInResult['receipt'] | null>(null);
  const [pending, startTransition] = useTransition();
  useRefreshOnResume(!receipt && !pending);
  const { visit, window: w } = context;

  const clock = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: APP_TIMEZONE, timeStyle: 'short' }).format(
      new Date(iso),
    );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      setState(IDLE);
      if (!submissionKey) {
        setState({ status: 'error', error: 'INTERNAL_ERROR' });
        return;
      }
      // 1. The device's location at this moment.
      setStep('locating');
      const location = await readLocation(20_000);
      if (!location.ok) {
        setStep('idle');
        setState({ status: 'error', error: location.error });
        return;
      }
      setReading(location.reading);
      // 2. The server decides (time, window, form, location policy).
      setStep('sending');
      let result;
      try {
        result = await guestCheckInAction({
          token,
          submissionKey,
          fullName,
          seatNumber,
          location: location.reading,
        });
      } catch {
        result = { ok: false as const, error: 'NETWORK', network: true };
      }
      setStep('idle');
      if (result.ok) {
        setReceipt(result.receipt);
        return;
      }
      setState({
        status: 'error',
        error: result.error,
        fieldErrors: 'fieldErrors' in result ? result.fieldErrors : undefined,
        retryAfterMinutes: 'retryAfterMinutes' in result ? result.retryAfterMinutes : undefined,
      });
    });
  };

  const header = (
    <div className="stack">
      <h2>{visit.title}</h2>
      <p className="muted">
        {text.date} · <span dir="ltr">{text.time}</span>
        {visit.locationName ? ` · ${visit.locationName}` : ''}
      </p>
    </div>
  );

  if (receipt) {
    return (
      <div className="stack">
        {header}
        <div
          className={`check-in-result check-in-${receipt.status.toLowerCase()}`}
          role="status"
          aria-live="polite"
        >
          <p className="check-in-status">{t('received')}</p>
          <p className="check-in-verdict">
            {receipt.status === 'LATE'
              ? ta('lateBy', { minutes: receipt.minutesLate })
              : ta('status.PRESENT')}
          </p>
          <p className="small">{tc('at', { time: clock(receipt.submittedAt) })}</p>
          <p className="small">
            {t('reference')} <span dir="ltr">{receipt.id.slice(-8).toUpperCase()}</span>
          </p>
        </div>
        <p className="alert alert-info">{t('notVerifiedNotice')}</p>
        <p>
          <Link href="/guest">{t('scanAnother')}</Link>
        </p>
      </div>
    );
  }

  if (visit.status === 'CANCELLED') {
    return (
      <div className="stack">
        {header}
        <p className="alert alert-error">{tc('cancelled')}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      <dl className="details">
        <div>
          <dt>{tc('opens')}</dt>
          <dd>{text.opensAt}</dd>
        </div>
        <div>
          <dt>{tc('onTimeUntil')}</dt>
          <dd>{text.onTimeUntil}</dd>
        </div>
        <div>
          <dt>{tc('closes')}</dt>
          <dd>{text.closesAt}</dd>
        </div>
      </dl>

      {w.state === 'NOT_OPEN' && (
        <div className="stack">
          <p className="alert alert-info">{tc('notOpen', { time: text.opensAt })}</p>
          <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>
            {tc('refresh')}
          </button>
        </div>
      )}
      {w.state === 'CLOSED' && <p className="alert alert-error">{tc('closed')}</p>}

      {w.state === 'OPEN' && (
        <form className="stack" onSubmit={submit} noValidate>
          <p className="alert alert-info">{t('notVerifiedNotice')}</p>
          <Field
            label={t('fullName')}
            name="fullName"
            autoComplete="name"
            required
            minLength={3}
            maxLength={200}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            errors={state.fieldErrors?.fullName}
          />
          <Field
            label={t('seatNumber')}
            name="seatNumber"
            dir="ltr"
            autoComplete="off"
            required
            maxLength={20}
            value={seatNumber}
            onChange={(event) => setSeatNumber(event.target.value)}
            errors={state.fieldErrors?.seatNumber}
          />
          <LocationRule rule={context.location} />
          {reading && <LocationReadout reading={reading} />}
          <FormError state={state} />
          {state.status === 'error' && state.error && <LocationHelp code={state.error} />}
          <button
            type="submit"
            className="btn btn-primary btn-large"
            disabled={pending}
            aria-busy={pending}
          >
            {step === 'locating'
              ? tc('locating')
              : step === 'sending'
                ? tc('sending')
                : state.status === 'error'
                  ? t('retry')
                  : t('submit')}
          </button>
        </form>
      )}
      <p className="muted small">{tc('serverTime', { time: text.serverTime })}</p>
    </div>
  );
}
