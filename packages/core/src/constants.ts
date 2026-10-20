/**
 * Project-wide constants shared by the API, the web app and the future mobile client.
 * Values that admins must be able to change (attendance windows, absence allowance,
 * training duration, ...) do NOT belong here — they live in the database.
 */

/** IANA zone used for every user-facing date/time display (§16.2). Storage is always UTC. */
export const APP_TIMEZONE = 'Africa/Cairo';

/** Stable service identifier reported by the API health endpoints. */
export const API_SERVICE_NAME = 'ftms-api';

/** Official brand palette sampled from the Faculty of Agriculture logo. */
export const BRAND_COLORS = {
  blue: '#00507D',
  navy: '#083F5F',
  gold: '#DBC35C',
  white: '#FFFFFF',
} as const;
