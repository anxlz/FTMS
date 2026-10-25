/**
 * The bridge to the FTMS Android app (Phase 8). The app is a Tauri shell that
 * shows this same web app; inside it, native Android features replace the
 * browser ones:
 *
 * - QR scanning with the camera (`barcode-scanner` plugin);
 * - the device location (`geolocation` plugin, with Android's permission flow);
 * - optional biometric sign-in with a key in the Android Keystore (the app's
 *   own `device-key` plugin): the key signs server challenges only after a
 *   strong biometric check, and never leaves the device.
 *
 * In a browser `inApp()` is false and the browser APIs are used. Errors become
 * message codes under `errors`. Nothing here decides attendance: the API does.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  type LocationReading,
  type LocationResult,
  readLocation as browserLocation,
} from './device';

/** Inside the Android app (Tauri), as opposed to a browser. */
export const inApp = (): boolean => typeof window !== 'undefined' && isTauri();

/* ─────────────────────────── QR codes ─────────────────────────── */

const TOKEN = /^[A-Za-z0-9_-]{10,100}$/;

/**
 * The attendance token in a scanned or pasted QR code: the printed code holds
 * `<web app>/check-in/<token>`. Only the token is kept; the host is ignored, so
 * a code cannot send the app elsewhere.
 */
export function tokenFromQr(text: string): string | null {
  const value = text.trim();
  if (TOKEN.test(value)) return value;
  const match = /\/check-in\/([A-Za-z0-9_-]{10,100})(?:[/?#]|$)/.exec(value);
  return match?.[1] ?? null;
}

export type ScanResult =
  | { ok: true; content: string }
  | { ok: false; error: 'CAMERA_DENIED' | 'SCAN_CANCELLED' | 'SCAN_UNAVAILABLE' };

/** Scans one QR code with the camera (app only). Asks for the camera permission on first use. */
export async function scanQr(): Promise<ScanResult> {
  if (!inApp()) return { ok: false, error: 'SCAN_UNAVAILABLE' };
  const scanner = await import('@tauri-apps/plugin-barcode-scanner');
  try {
    let permission = await scanner.checkPermissions();
    if (permission !== 'granted') permission = await scanner.requestPermissions();
    if (permission !== 'granted') return { ok: false, error: 'CAMERA_DENIED' };
    const scanned = await scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] });
    return { ok: true, content: scanned.content };
  } catch (error) {
    const text = String(error).toLowerCase();
    if (text.includes('cancel')) return { ok: false, error: 'SCAN_CANCELLED' };
    if (text.includes('permission')) return { ok: false, error: 'CAMERA_DENIED' };
    return { ok: false, error: 'SCAN_UNAVAILABLE' };
  }
}

export async function cancelScan(): Promise<void> {
  if (!inApp()) return;
  const scanner = await import('@tauri-apps/plugin-barcode-scanner');
  await scanner.cancel().catch(() => undefined);
}

/** Opens the app's page in Android settings (to re-allow a permanently denied permission). */
export async function openAppSettings(): Promise<void> {
  if (!inApp()) return;
  const scanner = await import('@tauri-apps/plugin-barcode-scanner');
  await scanner.openAppSettings().catch(() => undefined);
}

/* ─────────────────────────── location ─────────────────────────── */

/**
 * One fresh, high-accuracy reading (never a cached one). In the app the Android
 * permission is requested when attendance needs it, not at start-up.
 */
export async function readLocation(timeoutMs = 20_000): Promise<LocationResult> {
  if (!inApp()) return browserLocation(timeoutMs);
  const geo = await import('@tauri-apps/plugin-geolocation');
  try {
    let permission = await geo.checkPermissions();
    if (permission.location !== 'granted') {
      permission = await geo.requestPermissions(['location']);
    }
    if (permission.location !== 'granted') return { ok: false, error: 'GEOLOCATION_DENIED' };
    const position = await geo.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 0,
    });
    const reading: LocationReading = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: Number.isFinite(position.coords.accuracy)
        ? Math.round(position.coords.accuracy * 10) / 10
        : null,
    };
    return { ok: true, reading };
  } catch (error) {
    // Location services off, no fix within the timeout, or permission revoked meanwhile.
    return String(error).toLowerCase().includes('denied')
      ? { ok: false, error: 'GEOLOCATION_DENIED' }
      : { ok: false, error: 'GEOLOCATION_UNAVAILABLE' };
  }
}

/* ─────────────────────── optional biometric sign-in (device key) ─────────────────────── */

export interface DeviceKeyStatus {
  /** Strong biometrics are set up on the phone. */
  available: boolean;
  /** Why not, when unavailable (`noHardware`, `noneEnrolled`, `unavailable`, `securityUpdate`, …). */
  reason: string | null;
  /** A key exists and is registered under `credentialId` on this device. */
  enrolled: boolean;
  credentialId: string | null;
}

export type DeviceKeyError =
  | 'BIOMETRIC_CANCELLED'
  | 'BIOMETRIC_LOCKOUT'
  | 'BIOMETRIC_UNSUPPORTED'
  | 'BIOMETRIC_KEY_INVALIDATED'
  | 'BIOMETRIC_FAILED';

const DEVICE_KEY_ERRORS: readonly DeviceKeyError[] = [
  'BIOMETRIC_CANCELLED',
  'BIOMETRIC_LOCKOUT',
  'BIOMETRIC_UNSUPPORTED',
  'BIOMETRIC_KEY_INVALIDATED',
  'BIOMETRIC_FAILED',
];

/**
 * Maps the plugin's rejection (`{ message, code }` from DeviceKeyPlugin.kt) to a
 * message code; the code wins over the message text.
 */
export function deviceKeyErrorCode(error: unknown): DeviceKeyError {
  const fields =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof fields.code === 'string' ? fields.code : '';
  if ((DEVICE_KEY_ERRORS as readonly string[]).includes(code)) return code as DeviceKeyError;
  const text = code || String(fields.message ?? error);
  if (/cancel/i.test(text)) return 'BIOMETRIC_CANCELLED';
  if (/lockout/i.test(text)) return 'BIOMETRIC_LOCKOUT';
  if (/invalidated/i.test(text)) return 'BIOMETRIC_KEY_INVALIDATED';
  if (/notAvailable|noHardware|noneEnrolled|unsupported|notEnrolled/i.test(text)) {
    return 'BIOMETRIC_UNSUPPORTED';
  }
  return 'BIOMETRIC_FAILED';
}

export interface PromptTexts {
  title: string;
  subtitle: string;
  cancel: string;
}

export const deviceKey = {
  status: () => invoke<DeviceKeyStatus>('plugin:device-key|status'),
  /** A new Keystore key (any previous one is deleted); returns its public key (DER SPKI, base64). */
  createKey: () => invoke<{ publicKey: string }>('plugin:device-key|create_key'),
  /** Shows the biometric prompt, then signs `message` with the Keystore key. */
  sign: (message: string, prompt: PromptTexts) =>
    invoke<{ signature: string }>('plugin:device-key|sign', { message, ...prompt }),
  /** Remembers the server's id for the key (not secret). */
  setCredential: (credentialId: string) =>
    invoke<void>('plugin:device-key|set_credential', { credentialId }),
  /** Deletes the key and the local configuration. Android's own biometrics are untouched. */
  remove: () => invoke<void>('plugin:device-key|remove'),
};
