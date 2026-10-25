'use client';

import { deviceKeyMessage } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { deviceLoginAction, deviceLoginOptionsAction } from '@/lib/auth/actions';
import { type FormState, IDLE } from '@/lib/forms';
import { deviceKey, deviceKeyErrorCode, type DeviceKeyStatus, inApp } from '@/lib/native';
import { FormError } from './form-controls';

/**
 * "Sign in with fingerprint or face" in the Android app (Phase 8). Shown only when
 * the user turned biometric login on for this phone (Profile → Security). The
 * phone's biometric check unlocks a Keystore key that signs the server's
 * challenge; the server verifies the signature. Password and code sign-in remain.
 */
export function DeviceKeySignIn({ next }: { next?: string }) {
  const t = useTranslations('biometrics');
  const [status, setStatus] = useState<DeviceKeyStatus | null>(null);
  const [state, setState] = useState<FormState>(IDLE);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!inApp()) return;
    deviceKey.status().then(setStatus, () => setStatus(null));
  }, []);

  if (!status?.enrolled || !status.credentialId) return null;
  const credentialId = status.credentialId;

  const signIn = () =>
    startTransition(async () => {
      setState(IDLE);
      const start = await deviceLoginOptionsAction(credentialId);
      if (!start.ok) {
        setState({
          status: 'error',
          error: start.error,
          retryAfterMinutes: start.retryAfterMinutes,
        });
        return;
      }
      let signature: string;
      try {
        ({ signature } = await deviceKey.sign(
          deviceKeyMessage('login', start.challengeId, start.challenge, credentialId),
          { title: t('promptTitle'), subtitle: t('promptSubtitle'), cancel: t('promptCancel') },
        ));
      } catch (error) {
        const code = deviceKeyErrorCode(error);
        // A key invalidated by a new fingerprint or face enrollment cannot be used again.
        if (code === 'BIOMETRIC_KEY_INVALIDATED') await deviceKey.remove().catch(() => undefined);
        setState({ status: 'error', error: code });
        return;
      }
      setState(
        await deviceLoginAction({ challengeId: start.challengeId, credentialId, signature, next }),
      );
    });

  const forget = () =>
    startTransition(async () => {
      await deviceKey.remove().catch(() => undefined);
      setStatus({ ...status, enrolled: false, credentialId: null });
    });

  return (
    <div className="stack">
      <p className="divider">
        <span>{t('or')}</span>
      </p>
      <FormError state={state} />
      {state.status === 'error' && state.error === 'BIOMETRIC_FAILED' && (
        <p className="small">
          {t('deviceFailedHint')}{' '}
          <button type="button" className="link-button" onClick={forget}>
            {t('forgetOnDevice')}
          </button>
        </p>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={signIn}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? t('waiting') : t('signIn')}
      </button>
      <p className="muted small">{t('optionalNote')}</p>
    </div>
  );
}
