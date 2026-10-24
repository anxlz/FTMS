/**
 * Browser-side helpers for the device checks of §4.5 and §7.2: the platform
 * authenticator (biometrics) and the location reading. Errors become message
 * codes under `errors`.
 */

export type DeviceErrorCode =
  | 'BIOMETRIC_CANCELLED'
  | 'BIOMETRIC_UNSUPPORTED'
  | 'BIOMETRIC_CREDENTIAL_EXISTS'
  | 'BIOMETRIC_FAILED';

/** Turns a failed `navigator.credentials` ceremony into a message code. */
export function ceremonyErrorCode(error: unknown): DeviceErrorCode {
  const name = error instanceof Error ? error.name : '';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return 'BIOMETRIC_CREDENTIAL_EXISTS';
  }
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') {
    return 'BIOMETRIC_CANCELLED';
  }
  if (
    name === 'NotSupportedError' ||
    name === 'SecurityError' ||
    code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT' ||
    code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT' ||
    code === 'ERROR_INVALID_DOMAIN'
  ) {
    return 'BIOMETRIC_UNSUPPORTED';
  }
  return 'BIOMETRIC_FAILED';
}

export interface LocationReading {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export type LocationResult =
  | { ok: true; reading: LocationReading }
  | { ok: false; error: 'GEOLOCATION_DENIED' | 'GEOLOCATION_UNAVAILABLE' };

/** One fresh, high-accuracy reading of the device's position (never a cached one). */
export function readLocation(timeoutMs = 20_000): Promise<LocationResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, error: 'GEOLOCATION_UNAVAILABLE' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          reading: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: Number.isFinite(position.coords.accuracy)
              ? Math.round(position.coords.accuracy * 10) / 10
              : null,
          },
        }),
      (error) =>
        resolve({
          ok: false,
          error:
            error.code === error.PERMISSION_DENIED
              ? 'GEOLOCATION_DENIED'
              : 'GEOLOCATION_UNAVAILABLE',
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
