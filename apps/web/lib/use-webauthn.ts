import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useSyncExternalStore } from 'react';

const never = () => () => {};

/** `null` while rendering on the server; then whether this browser can do WebAuthn. */
export function useWebAuthnSupport(): boolean | null {
  return useSyncExternalStore(never, browserSupportsWebAuthn, () => null);
}
