'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { useTranslations } from 'next-intl';
import { useActionState, useState, useTransition } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/form-controls';
import { useInApp } from '@/lib/use-in-app';
import { useWebAuthnSupport } from '@/lib/use-webauthn';
import { ceremonyErrorCode } from '@/lib/device';
import { type FormState, IDLE } from '@/lib/forms';
import {
  registerDeviceAction,
  registrationOptionsAction,
  revokeDeviceAction,
} from './biometric-actions';

export interface DeviceRow {
  id: string;
  kind: 'PASSKEY' | 'ANDROID_KEY';
  name: string;
  added: string;
  lastUsed: string | null;
  multiDevice: boolean;
}

/**
 * The account's biometric sign-in devices (§4.5, Phase 8): browser passkeys and
 * Android app keys. Enable a browser's passkey here, see where biometric login
 * is on, and turn it off for a lost or replaced device. Optional, for signing in
 * only — never needed for attendance.
 */
export function BiometricDevices({
  devices,
  biometricSession,
}: {
  devices: DeviceRow[];
  biometricSession: boolean;
}) {
  const t = useTranslations('biometrics');
  return (
    <div className="stack">
      <p className="muted small">{t('profileIntro')}</p>
      {devices.length === 0 ? (
        <p className="empty">{t('noDevices')}</p>
      ) : (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id}>
              <div>
                <strong>{d.name}</strong>
                <span className="badge">
                  {d.kind === 'ANDROID_KEY' ? t('kindApp') : t('kindPasskey')}
                </span>
                {d.multiDevice && <span className="badge">{t('synced')}</span>}
                <p className="muted small">
                  {t('added', { date: d.added })} ·{' '}
                  {d.lastUsed ? t('lastUsed', { date: d.lastUsed }) : t('neverUsed')}
                </p>
              </div>
              <RemoveDevice id={d.id} name={d.name} />
            </li>
          ))}
        </ul>
      )}
      {biometricSession ? <ReauthNote /> : <AddDevice />}
    </div>
  );
}

/** In a browser (the app's DeviceKeySetting says the same for the phone). */
function ReauthNote() {
  const t = useTranslations('biometrics');
  const app = useInApp();
  if (app !== false) return null;
  return <p className="alert alert-info">{t('reauthNote')}</p>;
}

/** A browser passkey. The Android app uses its own Keystore key instead (see DeviceKeySetting). */
function AddDevice() {
  const t = useTranslations('biometrics');
  const supported = useWebAuthnSupport();
  const app = useInApp();
  const [name, setName] = useState('');
  const [state, setState] = useState<FormState>(IDLE);
  const [pending, startTransition] = useTransition();

  if (app !== false) return null;
  if (supported === false) return <p className="alert alert-info">{t('unsupported')}</p>;

  const enable = () =>
    startTransition(async () => {
      if (name.trim() === '') {
        setState({
          status: 'error',
          error: 'VALIDATION_FAILED',
          fieldErrors: { name: ['NAME_REQUIRED'] },
        });
        return;
      }
      setState(IDLE);
      const start = await registrationOptionsAction();
      if (!start.ok) {
        setState({ status: 'error', error: start.error });
        return;
      }
      let response;
      try {
        response = await startRegistration({
          optionsJSON: start.options as unknown as Parameters<
            typeof startRegistration
          >[0]['optionsJSON'],
        });
      } catch (error) {
        setState({ status: 'error', error: ceremonyErrorCode(error) });
        return;
      }
      const result = await registerDeviceAction({
        challengeId: start.challengeId,
        name: name.trim(),
        response,
      });
      setState(result);
      if (result.status === 'success') setName('');
    });

  return (
    <div className="stack">
      <h3>{t('enableTitle')}</h3>
      <FormError state={state} />
      <FormSuccess show={state.status === 'success'}>{t('enabled')}</FormSuccess>
      <Field
        label={t('deviceName')}
        name="name"
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
          disabled={pending || supported === null}
          aria-busy={pending}
        >
          {pending ? t('waiting') : t('enable')}
        </button>
      </p>
    </div>
  );
}

function RemoveDevice({ id, name }: { id: string; name: string }) {
  const t = useTranslations('biometrics');
  const [state, action] = useActionState(revokeDeviceAction, IDLE);
  return (
    <form action={action} className="inline-form">
      <FormError state={state} />
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="danger" confirm={t('removeConfirm', { name })}>
        {t('remove')}
      </SubmitButton>
    </form>
  );
}
