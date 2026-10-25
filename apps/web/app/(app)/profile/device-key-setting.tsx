'use client';

import { deviceKeyMessage } from '@ftms/core';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { Field, FormError, FormSuccess } from '@/components/form-controls';
import { type FormState, IDLE } from '@/lib/forms';
import { deviceKey, deviceKeyErrorCode, type DeviceKeyStatus, inApp } from '@/lib/native';
import {
  deviceRegistrationOptionsAction,
  registerDeviceKeyAction,
  revokeCredentialAction,
} from './biometric-actions';

export interface RegisteredDevice {
  id: string;
  credentialId: string;
}

/**
 * Profile → Security → Biometric login, inside the Android app (Phase 8): turn
 * biometric login on or off for this phone. Off by default. Turning it on needs a
 * password or code sign-in, creates a Keystore key that only the phone's
 * biometric check can unlock, and registers its public key; turning it off
 * revokes it on the server first, then deletes the key. Android's own biometric
 * settings, password and code sign-in, and attendance are never affected.
 */
export function DeviceKeySetting({
  registered,
  biometricSession,
}: {
  /** The account's active Android device keys, to recognize this phone's. */
  registered: RegisteredDevice[];
  biometricSession: boolean;
}) {
  const t = useTranslations('biometrics');
  const router = useRouter();
  const [status, setStatus] = useState<DeviceKeyStatus | null>(null);
  const [name, setName] = useState(t('defaultDeviceName'));
  const [state, setState] = useState<FormState>(IDLE);
  const [offline, setOffline] = useState(false);
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    deviceKey.status().then(setStatus, () => setStatus(null));
  }, []);
  useEffect(() => {
    if (inApp()) refresh();
  }, [refresh]);

  if (!status) return null;
  const mine = status.credentialId
    ? registered.find((d) => d.credentialId === status.credentialId)
    : undefined;
  const on = status.enrolled && Boolean(mine);
  // Registered on this phone, but no longer on the server (removed elsewhere).
  const orphaned = status.enrolled && !mine;

  const prompt = {
    title: t('promptTitle'),
    subtitle: t('promptEnableSubtitle'),
    cancel: t('promptCancel'),
  };

  const enable = () =>
    startTransition(async () => {
      setState(IDLE);
      setOffline(false);
      if (name.trim() === '') {
        setState({
          status: 'error',
          error: 'VALIDATION_FAILED',
          fieldErrors: { name: ['NAME_REQUIRED'] },
        });
        return;
      }
      const start = await deviceRegistrationOptionsAction();
      if (!start.ok) {
        setState({ status: 'error', error: start.error });
        return;
      }
      try {
        const { publicKey } = await deviceKey.createKey();
        const { signature } = await deviceKey.sign(
          deviceKeyMessage('register', start.challengeId, start.challenge),
          prompt,
        );
        const result = await registerDeviceKeyAction({
          challengeId: start.challengeId,
          publicKey,
          signature,
          name: name.trim(),
        });
        if (!result.ok) {
          await deviceKey.remove().catch(() => undefined);
          setState({ status: 'error', error: result.error });
          return;
        }
        await deviceKey.setCredential(result.credentialId);
        setState({ status: 'success' });
        refresh();
        router.refresh();
      } catch (error) {
        await deviceKey.remove().catch(() => undefined);
        setState({ status: 'error', error: deviceKeyErrorCode(error) });
      }
    });

  const disable = () =>
    startTransition(async () => {
      setState(IDLE);
      setOffline(false);
      if (!mine) return;
      let result;
      try {
        result = await revokeCredentialAction(mine.id);
      } catch {
        result = { ok: false as const, error: 'NETWORK', network: true };
      }
      if (!result.ok) {
        // Not revoked on the server: say so, and keep the setting as it is.
        setOffline(result.network);
        setState({ status: 'error', error: result.error });
        return;
      }
      await deviceKey.remove().catch(() => undefined);
      setState({ status: 'success' });
      refresh();
      router.refresh();
    });

  const removeLocal = () =>
    startTransition(async () => {
      await deviceKey.remove().catch(() => undefined);
      setOffline(false);
      setState(IDLE);
      refresh();
    });

  return (
    <div className="stack device-key-setting">
      <h4>{t('thisPhone')}</h4>
      <FormError state={state} />
      {offline && (
        <div className="alert alert-info">
          <p>{t('offlineNotRevoked')}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={removeLocal}
            disabled={pending}
          >
            {t('removeLocalOnly')}
          </button>
        </div>
      )}
      <FormSuccess show={state.status === 'success'}>
        {on ? t('enabled') : t('disabled')}
      </FormSuccess>
      {!status.available ? (
        <p className="alert alert-info">{t('unavailableOnPhone')}</p>
      ) : on ? (
        <>
          <p role="status">
            <strong>{t('stateOn')}</strong>
          </p>
          <p>
            <button
              type="button"
              className="btn btn-danger"
              onClick={disable}
              disabled={pending}
              aria-busy={pending}
            >
              {t('turnOff')}
            </button>
          </p>
        </>
      ) : orphaned ? (
        <div className="stack">
          <p className="alert alert-info">{t('orphaned')}</p>
          <p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={removeLocal}
              disabled={pending}
            >
              {t('removeLocalOnly')}
            </button>
          </p>
        </div>
      ) : biometricSession ? (
        <p className="alert alert-info">{t('reauthNote')}</p>
      ) : (
        <div className="stack">
          <p role="status">{t('stateOff')}</p>
          <Field
            label={t('deviceName')}
            name="deviceName"
            hint={t('deviceNameHint')}
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            errors={state.fieldErrors?.name}
          />
          <p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={enable}
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? t('waiting') : t('turnOn')}
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
