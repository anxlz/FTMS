import { z } from 'zod';
import { toWesternDigits } from '../text';

/**
 * Student names (§4.1, §4.2). Egyptian records use four name parts — first name,
 * father's, grandfather's and family name — but imported records may only carry
 * some of them, or only a full name. Stored values keep the spelling as entered
 * (whitespace tidied); comparisons use a separate, deliberately forgiving key.
 */
export const NAME_PARTS = ['firstName', 'fatherName', 'grandfatherName', 'familyName'] as const;
export type NamePart = (typeof NAME_PARTS)[number];
export type NameParts = Record<NamePart, string | null>;

export const NAME_PART_MAX_LENGTH = 60;
export const FULL_NAME_MAX_LENGTH = 200;

/** Trims, normalizes Unicode (NFC) and collapses inner whitespace. Keeps the spelling. */
export const tidyName = (value: string): string =>
  value.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Full name from the parts that are present, in order. */
export const composeFullName = (parts: Partial<Record<NamePart, string | null | undefined>>) =>
  NAME_PARTS.map((key) => parts[key])
    .filter((part): part is string => typeof part === 'string' && tidyName(part) !== '')
    .map(tidyName)
    .join(' ');

/**
 * Comparison key for names: ignores diacritics (tashkeel), tatweel, the usual
 * spelling variants of alef/hamza, yaa/alef maqsura and taa marbuta/haa, Latin
 * case, punctuation, digits' script and all spacing ("عبد الله" = "عبدالله").
 * Used only to decide whether two names refer to the same person, never stored.
 */
export function nameMatchKey(value: string): string {
  return toWesternDigits(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // harakat, superscript alef, Quranic marks
    .replace(/\u0640/g, '') // tatweel
    .replace(/[\u0622\u0623\u0625\u0671\u0672\u0673]/g, '\u0627') // alef with hamza/madda/wasla -> bare alef
    .replace(/\u0649/g, '\u064A') // alef maqsura -> yaa
    .replace(/\u0629/g, '\u0647') // taa marbuta -> haa
    .replace(/\u0624/g, '\u0648') // waw with hamza -> waw
    .replace(/\u0626/g, '\u064A') // yaa with hamza -> yaa
    .replace(/[^\p{L}\p{N}]/gu, ''); // spaces, punctuation, symbols
}

export const namesMatch = (a: string, b: string): boolean => {
  const left = nameMatchKey(a);
  return left !== '' && left === nameMatchKey(b);
};

/**
 * §14.1: a name typed for another student is only a consistency check. It
 * passes when it is the record's full name, or when at least two of its words
 * appear in the record's name in the same order (e.g. first and family name).
 * Spelling variants are absorbed by `nameMatchKey`.
 */
export function nameConsistentWith(typed: string, fullName: string): boolean {
  const words = (value: string) => value.split(/\s+/u).map(nameMatchKey).filter(Boolean);
  const wanted = words(typed);
  if (wanted.length === 0) return false;
  if (namesMatch(typed, fullName)) return true;
  if (wanted.length < 2) return false;
  let next = 0;
  for (const word of words(fullName)) {
    if (word === wanted[next]) next += 1;
    if (next === wanted.length) return true;
  }
  return false;
}

/** One name part: tidied, 1–60 characters, letters required. */
export const NamePartSchema = z
  .string()
  .transform(tidyName)
  .pipe(
    z
      .string()
      .min(1, { error: 'NAME_REQUIRED' })
      .max(NAME_PART_MAX_LENGTH, { error: 'NAME_TOO_LONG' })
      .regex(/\p{L}/u, { error: 'NAME_INVALID' }),
  );

const OptionalNamePart = z
  .union([NamePartSchema, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

/** All four parts required — the student signup form (§4.2). */
export const FourPartNameSchema = z.object({
  firstName: NamePartSchema,
  fatherName: NamePartSchema,
  grandfatherName: NamePartSchema,
  familyName: NamePartSchema,
});

/**
 * Staff-entered names: the first name plus at least one more part, because
 * imported and manually created records do not always have all four (§4.1).
 */
export const NamePartsSchema = z
  .object({
    firstName: NamePartSchema,
    fatherName: OptionalNamePart,
    grandfatherName: OptionalNamePart,
    familyName: OptionalNamePart,
  })
  .refine((p) => [p.fatherName, p.grandfatherName, p.familyName].some(Boolean), {
    error: 'NAME_TOO_SHORT',
    path: ['fatherName'],
  })
  .refine((p) => composeFullName(p).length <= FULL_NAME_MAX_LENGTH, {
    error: 'NAME_TOO_LONG',
    path: ['firstName'],
  });

/** Mobile/phone number: Western digits, optional leading +, 7–15 digits. */
export const normalizePhone = (value: string): string =>
  toWesternDigits(value).replace(/[\s\-().]/g, '');

export const PHONE_PATTERN = /^\+?\d{7,15}$/;

export const PhoneSchema = z
  .string()
  .transform(normalizePhone)
  .pipe(z.string().regex(PHONE_PATTERN, { error: 'PHONE_INVALID' }));
