import { z } from 'zod';
import { API_SERVICE_NAME } from './constants';

/**
 * Health-check contract between the API and its consumers (web app, uptime
 * monitors, future mobile client). Both sides parse with these schemas so a
 * contract drift fails loudly instead of rendering wrong status.
 */

/** `GET /health` — liveness: the process is up and serving HTTP. No dependency checks. */
export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal(API_SERVICE_NAME),
  version: z.string().min(1),
  timestamp: z.iso.datetime(),
  uptimeSeconds: z.number().nonnegative(),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

/**
 * - `up`: the dependency answered a real probe successfully.
 * - `down`: it is configured but the probe failed or timed out.
 * - `not_configured`: credentials are absent (allowed only outside production).
 */
export const DependencyStatusSchema = z.enum(['up', 'down', 'not_configured']);
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

export const DependencyCheckSchema = z.object({
  status: DependencyStatusSchema,
  latencyMs: z.number().nonnegative().optional(),
  detail: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

export const READINESS_DEPENDENCIES = ['database', 'redis', 'storage', 'mail'] as const;
export type ReadinessDependency = (typeof READINESS_DEPENDENCIES)[number];

/**
 * - `ready`: every dependency is up.
 * - `degraded`: nothing is down, but some dependency is not configured (development only).
 * - `not_ready`: a dependency is down, or (in production) one is not configured.
 */
export const ReadinessStatusSchema = z.enum(['ready', 'degraded', 'not_ready']);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

export const ReadinessResponseSchema = z.object({
  status: ReadinessStatusSchema,
  service: z.literal(API_SERVICE_NAME),
  timestamp: z.iso.datetime(),
  checks: z.object({
    database: DependencyCheckSchema,
    redis: DependencyCheckSchema,
    storage: DependencyCheckSchema,
    mail: DependencyCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

/** Pure aggregation rule, shared so every client interprets readiness identically. */
export function aggregateReadiness(
  checks: Record<ReadinessDependency, DependencyCheck>,
  options: { production: boolean },
): ReadinessStatus {
  const statuses = READINESS_DEPENDENCIES.map((name) => checks[name].status);
  if (statuses.includes('down')) return 'not_ready';
  if (statuses.includes('not_configured')) return options.production ? 'not_ready' : 'degraded';
  return 'ready';
}
