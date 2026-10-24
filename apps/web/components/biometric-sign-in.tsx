'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { biometricLoginAction, biometricLoginOptionsAction } from '@/lib/auth/actions';
import { useWebAuthnSupport } from '@/lib/use-webauthn';
import { ceremonyErrorCode } from '@/lib/device';
import { type FormState } from '@/lib/forms';
import { FormError } from './form-controls';

/**
 * "Sign in with biometrics" (§4.5): the device's passkey answers a server
 * challenge after its own fingerprint or face check. Shown only where the
 * browser supports WebAuthn; password and email-code sign-in always remain.
 */
export function BiometricSignIn({ next }: { next?: string }) {
  const t = useTranslations('biometrics');
  const supported = useWebAuthnSupport();
  const [state, setState] = useState<FormState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  if (!supported) return null;

  const signIn = () =>
    startTransition(async () => {
      setState({ status: 'idle' });
      const start = await biometricLoginOptionsAction();
      if (!start.ok) {
        setState({
          status: 'error',
          error: start.error,
          retryAfterMinutes: start.retryAfterMinutes,
        });
        return;
      }
      let response;
      try {
        response = await startAuthentication({
          optionsJSON: start.options as unknown as Parameters<
            typeof startAuthentication
          >[0]['optionsJSON'],
        });
      } catch (error) {
        setState({ status: 'error', error: ceremonyErrorCode(error) });
        return;
      }
      const result = await biometricLoginAction({ challengeId: start.challengeId, response, next });
      setState(result);
    });

  return (
    <div className="stack">
      <p className="divider">
        <span>{t('or')}</span>
      </p>
      <FormError state={state} />
      <button
        type="button"
        className="btn btn-secondary"
        onClick={signIn}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? t('waiting') : t('signIn')}
      </button>
      <p className="muted small">{t('signInHint')}</p>
    </div>
  );
}
