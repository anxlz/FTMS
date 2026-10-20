import { Injectable } from '@nestjs/common';
import { namesMatch, type VerificationIssue } from '@ftms/core';
import { type Prisma, type StudentProfile } from '../generated/prisma/client';

/** What the matching rule needs to know about the records involved. */
export interface IdentityMatchInput {
  /** Verified (code-confirmed) university email of the person. */
  email: string;
  fullName: string;
  /** The record with the submitted seat number, if any. */
  bySeat: Pick<StudentProfile, 'id' | 'userId' | 'universityEmail' | 'fullName'> | null;
  /** The record that already carries this email, if any. */
  byEmail: Pick<StudentProfile, 'id'> | null;
}

export type IdentityMatch = { kind: 'MATCH' } | { kind: 'NO_MATCH'; issue: VerificationIssue };

/**
 * §4.2: after the email is verified, does "seat number + identity" match an
 * existing (faculty-imported) record?
 *
 * - The email must not already belong to a different record.
 * - The seat number must exist and not be linked to another account.
 * - If the record has a university email, it must be this (verified) email —
 *   proof of identity faculty already recorded.
 * - If the record has no email, the full name must match (ignoring spelling
 *   variants and spacing, see `namesMatch`).
 *
 * Anything else is Case B: never trust the submitted identity automatically.
 */
export function decideIdentityMatch(input: IdentityMatchInput): IdentityMatch {
  const { bySeat, byEmail } = input;
  if (byEmail && byEmail.id !== bySeat?.id)
    return { kind: 'NO_MATCH', issue: 'EMAIL_ON_OTHER_RECORD' };
  if (!bySeat) return { kind: 'NO_MATCH', issue: 'NO_RECORD' };
  if (bySeat.userId !== null) return { kind: 'NO_MATCH', issue: 'SEAT_ALREADY_LINKED' };
  if (bySeat.universityEmail !== null) {
    return bySeat.universityEmail === input.email
      ? { kind: 'MATCH' }
      : { kind: 'NO_MATCH', issue: 'DETAILS_MISMATCH' };
  }
  return namesMatch(input.fullName, bySeat.fullName)
    ? { kind: 'MATCH' }
    : { kind: 'NO_MATCH', issue: 'DETAILS_MISMATCH' };
}

/**
 * Account ↔ student-record linking (§4.2 Case A, §4.3 first login). All writes
 * run inside the caller's transaction; the database guarantees one account per
 * record (unique user_id), one record per account, and that an ACTIVE student
 * account is always linked (deferred constraint trigger).
 */
@Injectable()
export class StudentLinkingService {
  /** Loads what `decideIdentityMatch` needs, inside the transaction. */
  async matchInput(
    tx: Prisma.TransactionClient,
    email: string,
    seatNumber: string,
    fullName: string,
  ): Promise<IdentityMatchInput & { bySeat: StudentProfile | null }> {
    const bySeat = await tx.studentProfile.findUnique({ where: { seatNumber } });
    const byEmail = await tx.studentProfile.findUnique({
      where: { universityEmail: email },
      select: { id: true },
    });
    return { email, fullName, bySeat, byEmail };
  }

  /**
   * Links `userId` to the record if it is still unlinked (race-safe: a
   * conditional update, so two people can never claim one record). Fills the
   * record's university email from the verified account when it was missing
   * (or, on a reviewer's decision, replaces it), and makes the account ACTIVE
   * with the record's authoritative name.
   */
  async link(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      studentId: string;
      email: string;
      /** Reviewer decision: replace a different email on the record with the account's. */
      replaceRecordEmail?: boolean;
    },
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await tx.studentProfile.updateMany({
      where: { id: params.studentId, userId: null },
      data: { userId: params.userId, linkedAt: now },
    });
    if (claimed.count !== 1) return false;
    const record = await tx.studentProfile.findUniqueOrThrow({ where: { id: params.studentId } });
    if (
      record.universityEmail === null ||
      (params.replaceRecordEmail && record.universityEmail !== params.email)
    ) {
      await tx.studentProfile.update({
        where: { id: record.id },
        data: { universityEmail: params.email },
      });
    }
    await tx.user.update({
      where: { id: params.userId },
      data: { status: 'ACTIVE', displayName: record.fullName },
    });
    return true;
  }

  /** Creates a student account (email verified by a code) — not yet linked. */
  createAccount(
    tx: Prisma.TransactionClient,
    params: { email: string; displayName: string; status: 'ACTIVE' | 'PENDING_VERIFICATION' },
  ) {
    return tx.user.create({
      data: {
        email: params.email,
        role: 'STUDENT',
        status: params.status,
        displayName: params.displayName,
        emailVerifiedAt: new Date(),
      },
    });
  }
}
