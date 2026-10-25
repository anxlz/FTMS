import { useSyncExternalStore } from 'react';
import { inApp } from './native';

const never = () => () => {};

/** `null` while rendering on the server; then whether this page runs inside the Android app. */
export function useInApp(): boolean | null {
  return useSyncExternalStore(never, inApp, () => null);
}
