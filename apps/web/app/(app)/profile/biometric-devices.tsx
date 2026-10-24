'use client';

import { startRegistration } from '@simplewebauthn/browser';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState, useTransition } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/form-controls';
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
  name: string;
  added: string;
  lastUsed: string | null;
  multiDevice: boolean;
}

/**
 * The account's biometric devices (§4.5): enable this device, see where
 * biometric sign-in is on, and turn it off for a lost or replaced device.
 */
export function BiometricDevices({
  devices,
  biometricSession,
  next,
}: {
  devices: DeviceRow[];
  biometricSession: boolean;
  next?: string;
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
      {biometricSession ? (
        <p className="alert alert-info">{t('reauthNote')}</p>
      ) : (
        <AddDevice next={next} />
      )}
    </div>
  );
}

function AddDevice({ next }: { next?: string }) {
  const t = useTranslations('biometrics');
  const supported = useWebAuthnSupport();
  const [name, setName] = useState('');
  const [state, setState] = useState<FormState>(IDLE);
  const [pending, startTransition] = useTransition();

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
      <FormSuccess show={state.status === 'success'}>
        {t('enabled')}{' '}
        {next && (
          <Link href={next} className="btn btn-primary">
            {t('continueCheckIn')}
          </Link>
        )}
      </FormSuccess>
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
