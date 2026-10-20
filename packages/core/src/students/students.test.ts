import { describe, expect, it } from 'vitest';
import { isUniversityEmail, normalizeSeatNumber, SeatNumberSchema } from '../auth/identity';
import { toWesternDigits } from '../text';
import {
  AssignMembersRequestSchema,
  CreateGroupRequestSchema,
  groupNameKey,
  SignupRequestSchema,
  SubmitProfileChangeRequestSchema,
  UpdateStudentRequestSchema,
} from './contracts';
import {
  composeFullName,
  FourPartNameSchema,
  nameMatchKey,
  NamePartsSchema,
  namesMatch,
  PhoneSchema,
} from './names';

describe('digits and seat numbers', () => {
  it('converts Arabic-Indic and Persian digits to Western digits', () => {
    expect(toWesternDigits('١٢٣٤٥٦٧٨٩٠')).toBe('1234567890');
    expect(toWesternDigits('۱۲۳')).toBe('123');
    expect(toWesternDigits('S-٤٥')).toBe('S-45');
  });

  it('normalizes seat numbers typed with Arabic digits or lowercase letters', () => {
    expect(normalizeSeatNumber(' ٢٠٢٤ab ')).toBe('2024AB');
    expect(SeatNumberSchema.parse('١٠٢٤')).toBe('1024');
    expect(SeatNumberSchema.safeParse('12 34').success).toBe(false);
  });
});

describe('student names (§4.1, §4.2)', () => {
  it('composes a full name from the parts that are present', () => {
    expect(
      composeFullName({
        firstName: '  محمد ',
        fatherName: '',
        grandfatherName: 'أحمد   سيد',
        familyName: 'علي',
      }),
    ).toBe('محمد أحمد سيد علي');
  });

  it('matches names despite common Arabic spelling variants and spacing', () => {
    expect(namesMatch('محمد عبد الله إبراهيم', 'محمد عبدالله ابراهيم')).toBe(true);
    expect(namesMatch('فاطمة', 'فاطمه')).toBe(true);
    expect(namesMatch('مُحَمَّد', 'محمد')).toBe(true);
    expect(namesMatch('على', 'علي')).toBe(true);
    expect(namesMatch('آمنة', 'امنه')).toBe(true);
    expect(namesMatch('مـحـمـد', 'محمد')).toBe(true);
    expect(namesMatch('Ahmed  Ali', 'ahmed ali')).toBe(true);
  });

  it('does not match different names, or empty ones', () => {
    expect(namesMatch('محمد', 'أحمد')).toBe(false);
    expect(namesMatch('محمد علي', 'محمد علي حسن')).toBe(false);
    expect(namesMatch('', '')).toBe(false);
    expect(nameMatchKey(' - ')).toBe('');
  });

  it('requires all four parts at signup', () => {
    expect(
      FourPartNameSchema.safeParse({
        firstName: 'محمد',
        fatherName: 'أحمد',
        grandfatherName: 'علي',
        familyName: 'حسن',
      }).success,
    ).toBe(true);
    const missing = FourPartNameSchema.safeParse({
      firstName: 'محمد',
      fatherName: '',
      grandfatherName: 'علي',
      familyName: 'حسن',
    });
    expect(missing.success).toBe(false);
  });

  it('accepts staff-entered names with at least two parts', () => {
    const parsed = NamePartsSchema.parse({ firstName: ' سارة ', familyName: 'محمود' });
    expect(parsed).toEqual({
      firstName: 'سارة',
      fatherName: null,
      grandfatherName: null,
      familyName: 'محمود',
    });
    expect(NamePartsSchema.safeParse({ firstName: 'سارة' }).success).toBe(false);
    expect(NamePartsSchema.safeParse({ firstName: '123', familyName: 'x' }).success).toBe(false);
  });
});

describe('phones and university emails', () => {
  it('normalizes phone numbers and rejects junk', () => {
    expect(PhoneSchema.parse('٠١٠ ١٢٣٤-٥٦٧٨')).toBe('01012345678');
    expect(PhoneSchema.parse('+20 (10) 1234 5678')).toBe('+201012345678');
    expect(PhoneSchema.safeParse('call me').success).toBe(false);
    expect(PhoneSchema.safeParse('123').success).toBe(false);
  });

  it('accepts only the configured university domains (and their subdomains)', () => {
    const domains = ['agr.asu.edu.eg'];
    expect(isUniversityEmail('ST1@AGR.asu.edu.eg', domains)).toBe(true);
    expect(isUniversityEmail('a@std.agr.asu.edu.eg', domains)).toBe(true);
    expect(isUniversityEmail('a@gmail.com', domains)).toBe(false);
    expect(isUniversityEmail('a@evilagr.asu.edu.eg', domains)).toBe(false);
    expect(isUniversityEmail('a@agr.asu.edu.eg', [])).toBe(false);
  });
});

describe('request contracts', () => {
  it('signup needs a four-part name, a seat number and an email', () => {
    const ok = SignupRequestSchema.safeParse({
      email: 'Student@AGR.asu.edu.eg',
      seatNumber: '١٢٣٤',
      firstName: 'محمد',
      fatherName: 'أحمد',
      grandfatherName: 'علي',
      familyName: 'حسن',
    });
    expect(ok.success && ok.data.email).toBe('student@agr.asu.edu.eg');
    expect(ok.success && ok.data.seatNumber).toBe('1234');
  });

  it('profile-change requests must change at least one protected field', () => {
    expect(SubmitProfileChangeRequestSchema.safeParse({ note: 'typo in my name' }).success).toBe(
      false,
    );
    expect(
      SubmitProfileChangeRequestSchema.safeParse({ familyName: 'حسن', note: 'typo in my name' })
        .success,
    ).toBe(true);
  });

  it('student updates clear optional values only explicitly', () => {
    expect(UpdateStudentRequestSchema.parse({ universityEmail: '' }).universityEmail).toBeNull();
    expect(UpdateStudentRequestSchema.parse({ phone: null }).phone).toBeNull();
    expect(UpdateStudentRequestSchema.safeParse({}).success).toBe(false);
  });

  it('group names compare case- and spacing-insensitively', () => {
    expect(groupNameKey('  Group   A ')).toBe(groupNameKey('group a'));
    expect(CreateGroupRequestSchema.parse({ name: ' المجموعة   الأولى ' }).name).toBe(
      'المجموعة الأولى',
    );
    expect(CreateGroupRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('membership assignment refuses duplicate student ids', () => {
    const id = '0190a6f0-0000-7000-8000-000000000001';
    expect(AssignMembersRequestSchema.safeParse({ studentIds: [id, id] }).success).toBe(false);
    expect(AssignMembersRequestSchema.parse({ studentIds: [id] }).moveFromOtherGroup).toBe(false);
  });
});
