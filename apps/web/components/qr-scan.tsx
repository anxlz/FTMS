'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { cancelScan, openAppSettings, scanQr, tokenFromQr } from '@/lib/native';
import { useInApp } from '@/lib/use-in-app';
import { Field } from './form-controls';

/**
 * Scan a visit's attendance QR code — with the camera in the Android app, or by
 * pasting the code's link anywhere — and open the check-in page for it: the
 * signed-in one, or the guest one. Scanning only finds the visit; nothing is
 * recorded until the server confirms a submission.
 */
export function QrScan({
  mode,
  compact = false,
}: {
  mode: 'signed-in' | 'guest';
  compact?: boolean;
}) {
  const t = useTranslations('scan');
  const router = useRouter();
  const app = useInApp();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [pending, startTransition] = useTransition();

  // While the camera is shown behind the page, only the scanning frame stays visible.
  useEffect(() => {
    document.documentElement.classList.toggle('scanning', scanning);
    return () => document.documentElement.classList.remove('scanning');
  }, [scanning]);

  const open = (token: string) => {
    const path = `/check-in/${encodeURIComponent(token)}`;
    router.push(mode === 'guest' ? `${path}/guest` : path);
  };

  const scan = () =>
    startTransition(async () => {
      setError(null);
      setScanning(true);
      const result = await scanQr();
      setScanning(false);
      if (!result.ok) {
        if (result.error !== 'SCAN_CANCELLED') setError(result.error);
        return;
      }
      const token = tokenFromQr(result.content);
      if (!token) {
        setError('QR_INVALID');
        return;
      }
      open(token);
    });

  const submitLink = (event: React.FormEvent) => {
    event.preventDefault();
    const token = tokenFromQr(link);
    if (!token) {
      setError('QR_INVALID');
      return;
    }
    setError(null);
    open(token);
  };

  return (
    <div className="stack">
      {app && (
        <button
          type="button"
          className={`btn btn-primary${compact ? '' : ' btn-large'}`}
          onClick={scan}
          disabled={pending}
          aria-busy={pending}
        >
          {t('scan')}
        </button>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          <p>{t(`errors.${error}`)}</p>
          {error === 'CAMERA_DENIED' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void openAppSettings()}
            >
              {t('openSettings')}
            </button>
          )}
        </div>
      )}
      {!compact && (
        <form className="stack" onSubmit={submitLink}>
          <Field
            label={app ? t('orPaste') : t('paste')}
            name="link"
            inputMode="url"
            dir="ltr"
            autoComplete="off"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://…/check-in/…"
          />
          <p>
            <button type="submit" className="btn btn-secondary">
              {t('openLink')}
            </button>
          </p>
        </form>
      )}
      {scanning && (
        <div className="scan-overlay" role="dialog" aria-modal="true" aria-label={t('scanning')}>
          <p className="scan-hint">{t('scanning')}</p>
          <div className="scan-frame" aria-hidden="true" />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void cancelScan();
              setScanning(false);
            }}
          >
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
