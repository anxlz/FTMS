import { z } from 'zod';

/**
 * Identity normalization shared by every surface. Emails are compared
 * case-insensitively by storing them trimmed + lowercased (the database enforces
 * the lowercase form with a CHECK constraint), so `Ali@AGR.asu.edu.eg` and
 * `ali@agr.asu.edu.eg` can never become two accounts (§4.2).
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Seat numbers are compared trimmed and uppercased. */
export const normalizeSeatNumber = (seat: string): string => seat.trim().toUpperCase();

export const SEAT_NUMBER_PATTERN = /^[A-Z0-9-]{1,20}$/;

export const EmailSchema = z
  .string()
  .trim()
  .max(254)
  .transform(normalizeEmail)
  .pipe(z.email({ error: 'EMAIL_INVALID' }));

export const SeatNumberSchema = z
  .string()
  .trim()
  .transform(normalizeSeatNumber)
  .pipe(z.string().regex(SEAT_NUMBER_PATTERN, { error: 'SEAT_NUMBER_INVALID' }));

/** Login identifier: an email (contains "@") or a seat number. */
export type LoginIdentifier =
  { kind: 'email'; email: string } | { kind: 'seat'; seatNumber: string };

export function parseLoginIdentifier(raw: string): LoginIdentifier | null {
  const value = raw.trim();
  if (value.includes('@')) {
    const parsed = EmailSchema.safeParse(value);
    return parsed.success ? { kind: 'email', email: parsed.data } : null;
  }
  const parsed = SeatNumberSchema.safeParse(value);
  return parsed.success ? { kind: 'seat', seatNumber: parsed.data } : null;
}
