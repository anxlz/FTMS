import {
  type GroupRef,
  type OwnStudentProfile,
  type StudentDetail,
  type StudentRecord,
} from '@ftms/core';
import { Prisma } from '../generated/prisma/client';

/** Relations needed to describe a record: its account and its active group. */
export const STUDENT_INCLUDE = {
  user: true,
  memberships: { where: { endedAt: null }, include: { group: true }, take: 1 },
} as const satisfies Prisma.StudentProfileInclude;

export type StudentWithRelations = Prisma.StudentProfileGetPayload<{
  include: typeof STUDENT_INCLUDE;
}>;

export const STUDENT_DETAIL_INCLUDE = {
  user: true,
  memberships: { include: { group: true }, orderBy: { startedAt: 'desc' } },
  profileChanges: { where: { status: 'PENDING' }, select: { id: true }, take: 1 },
} as const satisfies Prisma.StudentProfileInclude;

export type StudentWithHistory = Prisma.StudentProfileGetPayload<{
  include: typeof STUDENT_DETAIL_INCLUDE;
}>;

const groupRef = (group: { id: string; name: string } | undefined | null): GroupRef | null =>
  group ? { id: group.id, name: group.name } : null;

type RecordBase = Pick<
  StudentWithRelations,
  | 'id'
  | 'seatNumber'
  | 'fullName'
  | 'firstName'
  | 'fatherName'
  | 'grandfatherName'
  | 'familyName'
  | 'universityEmail'
  | 'phone'
  | 'createdAt'
  | 'updatedAt'
  | 'user'
>;

function base(record: RecordBase, group: GroupRef | null): StudentRecord {
  return {
    id: record.id,
    seatNumber: record.seatNumber,
    fullName: record.fullName,
    firstName: record.firstName,
    fatherName: record.fatherName,
    grandfatherName: record.grandfatherName,
    familyName: record.familyName,
    universityEmail: record.universityEmail,
    phone: record.phone,
    group,
    account: record.user
      ? {
          userId: record.user.id,
          email: record.user.email,
          status: record.user.status,
          hasPassword: record.user.passwordHash !== null,
          lastLoginAt: record.user.lastLoginAt?.toISOString() ?? null,
        }
      : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const toStudentRecord = (record: StudentWithRelations): StudentRecord =>
  base(record, groupRef(record.memberships[0]?.group));

export function toStudentDetail(record: StudentWithHistory): StudentDetail {
  const active = record.memberships.find((m) => m.endedAt === null);
  return {
    ...base(record, groupRef(active?.group)),
    memberships: record.memberships.map((m) => ({
      group: { id: m.group.id, name: m.group.name },
      startedAt: m.startedAt.toISOString(),
      endedAt: m.endedAt?.toISOString() ?? null,
      source: m.source,
    })),
    pendingProfileChangeId: record.profileChanges[0]?.id ?? null,
  };
}

export const toOwnProfile = (record: StudentWithRelations): OwnStudentProfile => ({
  seatNumber: record.seatNumber,
  fullName: record.fullName,
  firstName: record.firstName,
  fatherName: record.fatherName,
  grandfatherName: record.grandfatherName,
  familyName: record.familyName,
  universityEmail: record.universityEmail,
  phone: record.phone,
  group: groupRef(record.memberships[0]?.group),
});

/** Non-secret snapshot of a record for audit before/after comparisons (§15.2). */
export const studentSnapshot = (
  record: Pick<
    StudentWithRelations,
    | 'seatNumber'
    | 'fullName'
    | 'firstName'
    | 'fatherName'
    | 'grandfatherName'
    | 'familyName'
    | 'universityEmail'
    | 'phone'
    | 'userId'
  >,
  group?: GroupRef | null,
): Record<string, unknown> => ({
  seatNumber: record.seatNumber,
  fullName: record.fullName,
  firstName: record.firstName,
  fatherName: record.fatherName,
  grandfatherName: record.grandfatherName,
  familyName: record.familyName,
  universityEmail: record.universityEmail,
  phone: record.phone,
  linkedUserId: record.userId,
  ...(group !== undefined ? { group } : {}),
});
