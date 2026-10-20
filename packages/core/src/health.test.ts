import { describe, expect, it } from 'vitest';
import {
  aggregateReadiness,
  LivenessResponseSchema,
  ReadinessResponseSchema,
  type DependencyCheck,
  type ReadinessDependency,
} from './health';

const all = (status: DependencyCheck['status']): Record<ReadinessDependency, DependencyCheck> => ({
  database: { status },
  redis: { status },
  storage: { status },
  mail: { status },
});

describe('aggregateReadiness', () => {
  it('is ready when every dependency is up', () => {
    expect(aggregateReadiness(all('up'), { production: true })).toBe('ready');
  });

  it('is not_ready when any dependency is down, in any environment', () => {
    const checks = { ...all('up'), redis: { status: 'down' as const } };
    expect(aggregateReadiness(checks, { production: false })).toBe('not_ready');
    expect(aggregateReadiness(checks, { production: true })).toBe('not_ready');
  });

  it('is degraded in development when something is not configured', () => {
    const checks = { ...all('up'), mail: { status: 'not_configured' as const } };
    expect(aggregateReadiness(checks, { production: false })).toBe('degraded');
  });

  it('treats a missing configuration as not_ready in production', () => {
    const checks = { ...all('up'), storage: { status: 'not_configured' as const } };
    expect(aggregateReadiness(checks, { production: true })).toBe('not_ready');
  });

  it('prefers down over not_configured', () => {
    const checks = {
      ...all('up'),
      database: { status: 'down' as const },
      mail: { status: 'not_configured' as const },
    };
    expect(aggregateReadiness(checks, { production: false })).toBe('not_ready');
  });
});

describe('health schemas', () => {
  it('accepts a valid liveness payload', () => {
    const parsed = LivenessResponseSchema.safeParse({
      status: 'ok',
      service: 'ftms-api',
      version: '0.0.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 12.5,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a liveness payload from a different service', () => {
    const parsed = LivenessResponseSchema.safeParse({
      status: 'ok',
      service: 'something-else',
      version: '0.0.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a readiness payload missing a dependency', () => {
    const parsed = ReadinessResponseSchema.safeParse({
      status: 'ready',
      service: 'ftms-api',
      timestamp: new Date().toISOString(),
      checks: { database: { status: 'up' }, redis: { status: 'up' }, storage: { status: 'up' } },
    });
    expect(parsed.success).toBe(false);
  });
});
