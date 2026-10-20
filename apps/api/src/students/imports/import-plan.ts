import { createHash } from 'node:crypto';
import {
  composeFullName,
  EmailSchema,
  FULL_NAME_MAX_LENGTH,
  type FieldChange,
  groupNameKey,
  type ImportRow,
  type ImportRowError,
  type ImportSummary,
  isUniversityEmail,
  NAME_PART_MAX_LENGTH,
  NAME_PARTS,
  type NamePart,
  type NameParts,
  namesMatch,
  PhoneSchema,
  SeatNumberSchema,
  tidyName,
} from '@ftms/core';
import { type CellText, type RawImportRow } from './import-parser';

/**
 * A spreadsheet row after cell-level validation, as stored with the import.
 * Database-dependent checks happen later, in `planImport`, against live data.
 */
export interface NormalizedRow {
  rowNumber: number;
  seatNumber: string | null;
  /** The seat cell as typed, shown when it is invalid. */
  seatInput?: string | null;
  /** Present when the file gives name parts; null when it gives only a full name. */
  parts: NameParts | null;
  fullName: string | null;
  universityEmail: string | null;
  phone: string | null;
  group: string | null;
  errors: ImportRowError[];
}

const text = (cell: CellText | undefined): string | null =>
  typeof cell === 'string' ? cell.trim() || null : null;

const hasLetter = (value: string) => /\p{L}/u.test(value);

/**
 * Egyptian mobile numbers have 11 digits starting with 01; spreadsheets storing
 * them as numbers drop the leading zero. Restore it for that exact shape only.
 */
const restoreLeadingZero = (phone: string) => (/^1[0125]\d{8}$/.test(phone) ? `0${phone}` : phone);

/** Cell-level validation: formats, required values, name consistency, email domain. */
export function normalizeRow(
  raw: RawImportRow,
  universityDomains: readonly string[],
): NormalizedRow {
  const errors = new Set<ImportRowError>();
  const unreadable = Object.values(raw.cells).some(
    (cell) => cell !== null && typeof cell === 'object',
  );
  if (unreadable) errors.add('CELL_UNREADABLE');

  // Seat number
  let seatNumber: string | null = null;
  const seatText = text(raw.cells.seatNumber);
  if (!seatText) errors.add('SEAT_REQUIRED');
  else {
    const parsed = SeatNumberSchema.safeParse(seatText);
    if (parsed.success) seatNumber = parsed.data;
    else errors.add('SEAT_NUMBER_INVALID');
  }

  // Name: four parts where available, otherwise a full name (§4.1)
  let parts: NameParts | null = null;
  let fullName: string | null = null;
  const partValues = Object.fromEntries(
    NAME_PARTS.map((key) => [key, text(raw.cells[key]) ? tidyName(text(raw.cells[key])!) : null]),
  ) as NameParts;
  const fullNameCell = text(raw.cells.fullName) ? tidyName(text(raw.cells.fullName)!) : null;
  const givenParts = NAME_PARTS.filter((key) => partValues[key] !== null);

  if (givenParts.length > 0) {
    if (!partValues.firstName || givenParts.length < 2) errors.add('NAME_TOO_SHORT');
    if (givenParts.some((key) => partValues[key]!.length > NAME_PART_MAX_LENGTH)) {
      errors.add('NAME_TOO_LONG');
    }
    if (givenParts.some((key) => !hasLetter(partValues[key]!))) errors.add('NAME_INVALID');
    const composed = composeFullName(partValues);
    if (composed.length > FULL_NAME_MAX_LENGTH) errors.add('NAME_TOO_LONG');
    if (fullNameCell && !namesMatch(fullNameCell, composed)) errors.add('NAME_PARTS_MISMATCH');
    parts = partValues;
    fullName = composed;
  } else if (fullNameCell) {
    if (fullNameCell.length > FULL_NAME_MAX_LENGTH) errors.add('NAME_TOO_LONG');
    if (!hasLetter(fullNameCell)) errors.add('NAME_INVALID');
    else if (fullNameCell.split(' ').length < 2) errors.add('NAME_TOO_SHORT');
    fullName = fullNameCell;
  } else {
    errors.add('NAME_REQUIRED');
  }

  // Optional values
  let universityEmail: string | null = null;
  const emailText = text(raw.cells.universityEmail);
  if (emailText) {
    const parsed = EmailSchema.safeParse(emailText);
    if (!parsed.success) errors.add('EMAIL_INVALID');
    else if (!isUniversityEmail(parsed.data, universityDomains)) errors.add('EMAIL_NOT_UNIVERSITY');
    else universityEmail = parsed.data;
  }

  let phone: string | null = null;
  const phoneText = text(raw.cells.phone);
  if (phoneText) {
    const parsed = PhoneSchema.safeParse(phoneText);
    if (parsed.success) phone = restoreLeadingZero(parsed.data);
    else errors.add('PHONE_INVALID');
  }

  const groupText = text(raw.cells.group);
  const group = groupText ? groupText.normalize('NFC').replace(/\s+/gu, ' ').trim() : null;

  return {
    rowNumber: raw.rowNumber,
    seatNumber,
    seatInput: seatText,
    parts,
    fullName,
    universityEmail,
    phone,
    group,
    errors: [...errors],
  };
}

/* ───────────────────────────── planning ───────────────────────────── */

export interface ExistingStudent {
  id: string;
  userId: string | null;
  seatNumber: string;
  fullName: string;
  firstName: string | null;
  fatherName: string | null;
  grandfatherName: string | null;
  familyName: string | null;
  universityEmail: string | null;
  phone: string | null;
  group: { id: string; name: string } | null;
}

export interface PlanContext {
  /** Existing records by seat number (only those the file mentions). */
  bySeat: ReadonlyMap<string, ExistingStudent>;
  /** Who already uses an email the file mentions: a student record, or a staff login. */
  emailOwners: ReadonlyMap<string, { studentId: string | null; staff: boolean }>;
  /** Groups by `groupNameKey`. */
  groups: ReadonlyMap<string, { id: string; name: string; archived: boolean }>;
  /** The importer may assign groups (`groups.manage`). */
  canAssignGroups: boolean;
}

/** What to write for a row, kept next to the public plan row. */
export interface RowWrite {
  rowNumber: number;
  action: 'CREATE' | 'UPDATE';
  studentId: string | null;
  seatNumber: string;
  data: {
    fullName?: string;
    firstName?: string | null;
    fatherName?: string | null;
    grandfatherName?: string | null;
    familyName?: string | null;
    universityEmail?: string | null;
    phone?: string | null;
  };
  /** Target group id when the row assigns or changes the group. */
  groupId: string | null;
}

export interface ImportPlan {
  rows: ImportRow[];
  writes: RowWrite[];
  summary: ImportSummary;
  digest: string;
}

const change = (field: string, from: string | null, to: string | null): FieldChange => ({
  field,
  from,
  to,
});

/**
 * Decides, row by row, what committing would do against the current database:
 * CREATE a record, UPDATE an existing one (only fields the file fills in — blank
 * cells never erase data), leave it UNCHANGED, or skip it with ERRORs. Pure:
 * the same rows and context always give the same plan and digest.
 */
export function planImport(rows: readonly NormalizedRow[], context: PlanContext): ImportPlan {
  const seatCount = new Map<string, number>();
  const emailCount = new Map<string, number>();
  for (const row of rows) {
    if (row.seatNumber) seatCount.set(row.seatNumber, (seatCount.get(row.seatNumber) ?? 0) + 1);
    if (row.universityEmail) {
      emailCount.set(row.universityEmail, (emailCount.get(row.universityEmail) ?? 0) + 1);
    }
  }

  const planRows: ImportRow[] = [];
  const writes: RowWrite[] = [];

  for (const row of rows) {
    const errors = new Set<ImportRowError>(row.errors);
    if (row.seatNumber && (seatCount.get(row.seatNumber) ?? 0) > 1)
      errors.add('DUPLICATE_SEAT_IN_FILE');
    if (row.universityEmail && (emailCount.get(row.universityEmail) ?? 0) > 1) {
      errors.add('DUPLICATE_EMAIL_IN_FILE');
    }

    let group: { id: string; name: string } | null = null;
    if (row.group) {
      const found = context.groups.get(groupNameKey(row.group));
      if (!context.canAssignGroups) errors.add('GROUP_PERMISSION_REQUIRED');
      else if (!found) errors.add('GROUP_NOT_FOUND');
      else if (found.archived) errors.add('GROUP_ARCHIVED');
      else group = { id: found.id, name: found.name };
    }

    const existing = row.seatNumber ? context.bySeat.get(row.seatNumber) : undefined;
    if (row.universityEmail) {
      const owner = context.emailOwners.get(row.universityEmail);
      if (owner?.staff) errors.add('EMAIL_USED_BY_STAFF');
      else if (owner?.studentId && owner.studentId !== existing?.id) {
        errors.add('EMAIL_USED_BY_OTHER_STUDENT');
      }
    }

    const changes: FieldChange[] = [];
    const data: RowWrite['data'] = {};
    let groupChange: string | null = null;

    if (existing && errors.size === 0) {
      if (row.parts) {
        for (const key of NAME_PARTS) {
          if (row.parts[key] !== null && row.parts[key] !== existing[key]) {
            changes.push(change(key, existing[key], row.parts[key]));
          }
        }
        const nextParts = Object.fromEntries(
          NAME_PARTS.map((key) => [key, row.parts![key] ?? existing[key]]),
        ) as Record<NamePart, string | null>;
        const nextFullName = composeFullName(nextParts);
        if (changes.length > 0) {
          Object.assign(data, nextParts, { fullName: nextFullName });
          if (nextFullName !== existing.fullName) {
            changes.push(change('fullName', existing.fullName, nextFullName));
          }
        }
      } else if (row.fullName && row.fullName !== existing.fullName) {
        // A full name alone cannot be split reliably: it replaces the parts.
        changes.push(change('fullName', existing.fullName, row.fullName));
        for (const key of NAME_PARTS) {
          if (existing[key] !== null) changes.push(change(key, existing[key], null));
        }
        Object.assign(data, {
          fullName: row.fullName,
          firstName: null,
          fatherName: null,
          grandfatherName: null,
          familyName: null,
        });
      }
      if (row.universityEmail && row.universityEmail !== existing.universityEmail) {
        if (existing.userId !== null) errors.add('EMAIL_LOCKED_BY_ACCOUNT');
        else {
          changes.push(change('universityEmail', existing.universityEmail, row.universityEmail));
          data.universityEmail = row.universityEmail;
        }
      }
      if (row.phone && row.phone !== existing.phone) {
        changes.push(change('phone', existing.phone, row.phone));
        data.phone = row.phone;
      }
      if (group && group.id !== existing.group?.id) {
        changes.push(change('group', existing.group?.name ?? null, group.name));
        groupChange = group.id;
      }
    }

    const action: ImportRow['action'] =
      errors.size > 0
        ? 'ERROR'
        : !existing
          ? 'CREATE'
          : changes.length > 0
            ? 'UPDATE'
            : 'UNCHANGED';

    planRows.push({
      rowNumber: row.rowNumber,
      action,
      seatNumber: row.seatNumber ?? row.seatInput ?? null,
      fullName: row.fullName,
      universityEmail: row.universityEmail,
      group: row.group,
      errors: [...errors],
      changes: action === 'UPDATE' ? changes : [],
      studentId: existing?.id ?? null,
    });

    if (action === 'CREATE') {
      writes.push({
        rowNumber: row.rowNumber,
        action,
        studentId: null,
        seatNumber: row.seatNumber!,
        data: {
          fullName: row.fullName!,
          ...(row.parts ?? {}),
          universityEmail: row.universityEmail,
          phone: row.phone,
        },
        groupId: group?.id ?? null,
      });
    } else if (action === 'UPDATE') {
      writes.push({
        rowNumber: row.rowNumber,
        action,
        studentId: existing!.id,
        seatNumber: row.seatNumber!,
        data,
        groupId: groupChange,
      });
    }
  }

  const summary: ImportSummary = {
    total: planRows.length,
    create: planRows.filter((r) => r.action === 'CREATE').length,
    update: planRows.filter((r) => r.action === 'UPDATE').length,
    unchanged: planRows.filter((r) => r.action === 'UNCHANGED').length,
    error: planRows.filter((r) => r.action === 'ERROR').length,
  };
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        planRows.map((r) => [r.rowNumber, r.action, r.studentId, r.errors, r.changes]),
      ),
    )
    .digest('hex');
  return { rows: planRows, writes, summary, digest };
}
