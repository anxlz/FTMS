import {
  type GroupRef,
  type VisitFile,
  type VisitFileKind,
  visitPhase,
  type VisitSummary,
} from '@ftms/core';
import { type Prisma, type TrainingVisit } from '../generated/prisma/client';
import { byName, fromDbDate, fromDbTime, timingOf } from './db-values';

export const VISIT_INCLUDE = {
  groups: { select: { group: { select: { id: true, name: true } } } },
} as const satisfies Prisma.TrainingVisitInclude;

export const VISIT_DETAIL_INCLUDE = {
  ...VISIT_INCLUDE,
  files: { orderBy: { createdAt: 'asc' } },
  schedule: { select: { id: true, title: true } },
  program: { select: { id: true, name: true } },
} as const satisfies Prisma.TrainingVisitInclude;

export type VisitWithGroups = Prisma.TrainingVisitGetPayload<{ include: typeof VISIT_INCLUDE }>;
export type VisitWithDetail = Prisma.TrainingVisitGetPayload<{
  include: typeof VISIT_DETAIL_INCLUDE;
}>;

export const groupsOf = (visit: VisitWithGroups): GroupRef[] =>
  byName(visit.groups.map((g) => g.group));

export const toVisitSummary = (visit: VisitWithGroups, now: Date): VisitSummary => ({
  id: visit.id,
  title: visit.title,
  date: fromDbDate(visit.date),
  startTime: fromDbTime(visit.startTime),
  endTime: visit.endTime ? fromDbTime(visit.endTime) : null,
  startsAt: visit.startsAt.toISOString(),
  endsAt: visit.endsAt?.toISOString() ?? null,
  status: visit.status,
  phase: visitPhase(visit, now),
  cancelReason: visit.cancelReason,
  locationName: visit.locationName,
  groups: groupsOf(visit),
  scheduleId: visit.scheduleId,
});

export interface FileRow {
  id: string;
  kind: VisitFileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

export const toVisitFile = (file: FileRow, url: string): VisitFile => ({
  id: file.id,
  kind: file.kind,
  fileName: file.fileName,
  contentType: file.contentType,
  sizeBytes: file.sizeBytes,
  url,
  createdAt: file.createdAt.toISOString(),
});

/** What students are told about a visit (rendered in their language by the app). */
export const notificationData = (visit: TrainingVisit): Record<string, unknown> => ({
  visitId: visit.id,
  title: visit.title,
  date: fromDbDate(visit.date),
  startTime: fromDbTime(visit.startTime),
  endTime: visit.endTime ? fromDbTime(visit.endTime) : null,
  locationName: visit.locationName,
});

export const visitLink = (id: string): string => `/visits/${id}`;

/** The audited state of a visit: everything a reviewer needs to see what changed. */
export const auditSnapshot = (visit: TrainingVisit, groupNames: string[]) => ({
  title: visit.title,
  description: visit.description,
  date: fromDbDate(visit.date),
  startTime: fromDbTime(visit.startTime),
  endTime: visit.endTime ? fromDbTime(visit.endTime) : null,
  location: {
    name: visit.locationName,
    latitude: visit.latitude,
    longitude: visit.longitude,
    mapUrl: visit.mapUrl,
  },
  timing: timingOf(visit),
  timingOverridden: visit.timingOverridden,
  groups: [...groupNames].sort((a, b) => a.localeCompare(b, 'ar')),
  status: visit.status,
});

export type AuditSnapshot = ReturnType<typeof auditSnapshot>;

/** Only the fields that differ, as `before`/`after` audit payloads. */
export function diffSnapshots(
  before: AuditSnapshot,
  after: AuditSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown>; fields: string[] } {
  const fields = (Object.keys(after) as (keyof AuditSnapshot)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return {
    before: Object.fromEntries(fields.map((k) => [k, before[k]])),
    after: Object.fromEntries(fields.map((k) => [k, after[k]])),
    fields,
  };
}
