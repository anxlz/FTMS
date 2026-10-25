import { describe, expect, it } from 'vitest';
import {
  actionsInCategory,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  auditCategoryOf,
  DECISION_ACTIONS,
  isAuditAction,
} from './catalogue';
import { auditChanges } from './changes';
import {
  AttendanceSummaryQuerySchema,
  AuditExportQuerySchema,
  AuditIdSchema,
  ListAuditLogsQuerySchema,
} from './contracts';

describe('audit catalogue (§15.1)', () => {
  it('lists each action once and puts every action in exactly one category', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    const counted = AUDIT_CATEGORIES.flatMap((c) => actionsInCategory(c));
    expect(counted.sort()).toEqual([...AUDIT_ACTIONS].sort());
    for (const category of AUDIT_CATEGORIES)
      expect(actionsInCategory(category).length).toBeGreaterThan(0);
  });

  it('groups actions by what they are about', () => {
    expect(auditCategoryOf('auth.login')).toBe('SIGN_IN');
    expect(auditCategoryOf('user.permissions_changed')).toBe('ACCOUNTS');
    expect(auditCategoryOf('student.deleted')).toBe('STUDENTS');
    expect(auditCategoryOf('student.verification.approved')).toBe('REVIEWS');
    expect(auditCategoryOf('profile_change.rejected')).toBe('REVIEWS');
    expect(auditCategoryOf('group.member_moved')).toBe('GROUPS');
    expect(auditCategoryOf('student_import.committed')).toBe('IMPORTS');
    expect(auditCategoryOf('program.updated')).toBe('SETTINGS');
    expect(auditCategoryOf('schedule_exception.removed')).toBe('SCHEDULES');
    expect(auditCategoryOf('visit.cancelled')).toBe('VISITS');
    expect(auditCategoryOf('attendance.corrected')).toBe('ATTENDANCE');
    expect(auditCategoryOf('attendance.exported')).toBe('EXPORTS');
    expect(auditCategoryOf('ticket.note_added')).toBe('TICKETS');
    expect(auditCategoryOf('group_swap.approved')).toBe('GROUP_SWAPS');
  });

  it('treats approvals, rejections, consent, corrections and access changes as decisions', () => {
    for (const action of DECISION_ACTIONS) expect(isAuditAction(action)).toBe(true);
    expect(DECISION_ACTIONS).toContain('group_swap.approved');
    expect(DECISION_ACTIONS).toContain('group_swap.counterpart_accepted');
    expect(DECISION_ACTIONS).toContain('attendance.corrected');
    expect(DECISION_ACTIONS).toContain('user.permissions_changed');
    expect(DECISION_ACTIONS).not.toContain('visit.created');
    expect(isAuditAction('visit.deleted_everything')).toBe(false);
  });
});

describe('before/after comparison (§15.3)', () => {
  it('lists every field, marks what changed, and flattens nested settings', () => {
    expect(
      auditChanges(
        { title: 'Orchard', timing: { graceMinutes: 15, checkInClosesMinutes: 60 }, groups: ['A'] },
        {
          title: 'Orchard',
          timing: { graceMinutes: 20, checkInClosesMinutes: 60 },
          groups: ['A', 'B'],
        },
      ),
    ).toEqual([
      { field: 'title', before: 'Orchard', after: 'Orchard', changed: false },
      { field: 'timing.graceMinutes', before: 15, after: 20, changed: true },
      { field: 'timing.checkInClosesMinutes', before: 60, after: 60, changed: false },
      { field: 'groups', before: ['A'], after: ['A', 'B'], changed: true },
    ]);
  });

  it('shows creations and deletions as one-sided changes', () => {
    expect(auditChanges(null, { status: 'LATE', minutesLate: 5 })).toEqual([
      { field: 'status', before: undefined, after: 'LATE', changed: true },
      { field: 'minutesLate', before: undefined, after: 5, changed: true },
    ]);
    expect(auditChanges({ seatNumber: '2021001' }, null)).toEqual([
      { field: 'seatNumber', before: '2021001', after: undefined, changed: true },
    ]);
    expect(auditChanges(null, null)).toEqual([]);
  });

  it('compares objects regardless of key order, and null with a missing key', () => {
    const [same] = auditChanges({ v: [{ a: 1, b: 2 }] }, { v: [{ b: 2, a: 1 }] });
    expect(same!.changed).toBe(false);
    expect(auditChanges({ reason: null }, {})[0]!.changed).toBe(true);
  });
});

describe('audit queries', () => {
  it('defaults to every actor, page 1 of 50, decisions off', () => {
    expect(ListAuditLogsQuerySchema.parse({})).toEqual({
      scope: 'all',
      decisions: false,
      page: 1,
      pageSize: 50,
    });
  });

  it('accepts only known actions, categories and resource types', () => {
    expect(ListAuditLogsQuerySchema.safeParse({ action: 'visit.cancelled' }).success).toBe(true);
    expect(ListAuditLogsQuerySchema.safeParse({ action: 'visit.exploded' }).success).toBe(false);
    expect(ListAuditLogsQuerySchema.safeParse({ category: 'VISITS' }).success).toBe(true);
    expect(ListAuditLogsQuerySchema.safeParse({ resourceType: 'password' }).success).toBe(false);
    expect(ListAuditLogsQuerySchema.safeParse({ decisions: 'true' }).data?.decisions).toBe(true);
  });

  it('refuses a period that ends before it starts', () => {
    const r = ListAuditLogsQuerySchema.safeParse({ from: '2026-11-02', to: '2026-11-01' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ['to'], message: 'END_BEFORE_START' });
    expect(AuditExportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false);
    expect(AuditExportQuerySchema.parse({ format: 'csv' }).locale).toBe('ar');
  });

  it('takes audit ids as positive integers only', () => {
    expect(AuditIdSchema.safeParse('42').success).toBe(true);
    for (const bad of ['0', '-1', '1.5', 'abc', '1; DROP TABLE', '99999999999999999999'])
      expect(AuditIdSchema.safeParse(bad).success).toBe(false);
  });

  it('filters the summary report by group (or none), name and standing', () => {
    expect(
      AttendanceSummaryQuerySchema.safeParse({ group: 'none', standing: 'over' }).success,
    ).toBe(true);
    expect(AttendanceSummaryQuerySchema.safeParse({ standing: 'excellent' }).success).toBe(false);
  });
});
