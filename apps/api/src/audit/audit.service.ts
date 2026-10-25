import { Injectable, Logger } from '@nestjs/common';
import { type AuditAction, type AuditResourceType, type Role } from '@ftms/core';
import { type RequestContext } from '../common/request-context';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditActor {
  id: string;
  displayName: string;
  role: Role;
}

export interface AuditEvent {
  /** Who acted. `null` for unauthenticated attempts and system jobs. */
  actor: AuditActor | null;
  /** From the shared catalogue (`AUDIT_ACTIONS`), e.g. `auth.login`, `user.status_changed`. */
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string | null;
  outcome: 'SUCCESS' | 'FAILURE';
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  context?: RequestContext | null;
}

/**
 * Keys whose values must never be written to the audit log (§15.2). Boolean
 * facts such as `hasPassword` are allowed through.
 */
const SECRET_KEY = /password|secret|token|code|hash|otp|credential|authorization|cookie/i;
/** Case-sensitive on purpose: `hasPassword` passes, `hash` / `hashValue` do not. */
const BOOLEAN_FACT_KEY = /^has[A-Z]/;
const isSecretKey = (key: string): boolean => SECRET_KEY.test(key) && !BOOLEAN_FACT_KEY.test(key);

/** Defensive scrub: replaces any secret-looking field with "[redacted]", recursively. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      isSecretKey(k) ? '[redacted]' : redactSecrets(v, depth + 1),
    ]),
  );
}

const json = (value: Record<string, unknown> | null | undefined) =>
  value ? (redactSecrets(value) as Prisma.InputJsonValue) : Prisma.DbNull;

const toRow = (event: AuditEvent): Prisma.AuditLogCreateManyInput => ({
  actorId: event.actor?.id ?? null,
  actorName: event.actor?.displayName ?? null,
  actorRole: event.actor?.role ?? null,
  action: event.action,
  resourceType: event.resourceType,
  resourceId: event.resourceId ?? null,
  outcome: event.outcome,
  reason: event.reason ?? null,
  before: json(event.before),
  after: json(event.after),
  metadata: json(event.metadata),
  ip: event.context?.ip ?? null,
  userAgent: event.context?.userAgent ?? null,
});

/**
 * The single audit writer for the whole application (§15.4). Rows are
 * append-only at the database level. Callers pass `tx` to make the audit row
 * part of the same transaction as the change it records.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEvent, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({ data: toRow(event) });
  }

  /** Many events in one statement (bulk operations such as spreadsheet imports). */
  async recordMany(events: AuditEvent[], tx?: Prisma.TransactionClient): Promise<void> {
    if (events.length === 0) return;
    const client = tx ?? this.prisma;
    await client.auditLog.createMany({ data: events.map(toRow) });
  }

  /**
   * For failure events outside a transaction: an audit write must never turn a
   * clean 401/403 into a 500, so errors are logged instead of thrown.
   */
  async recordSafely(event: AuditEvent): Promise<void> {
    try {
      await this.record(event);
    } catch (error) {
      this.logger.error(
        `Could not write audit event ${event.action}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
