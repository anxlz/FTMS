import { decideIdentityMatch, type IdentityMatchInput } from './student-linking.service';

const record = (over: Partial<NonNullable<IdentityMatchInput['bySeat']>> = {}) => ({
  id: 'record-1',
  userId: null,
  universityEmail: null,
  fullName: 'محمد أحمد علي حسن',
  ...over,
});

const decide = (over: Partial<IdentityMatchInput>) =>
  decideIdentityMatch({
    email: 'student@agr.asu.edu.eg',
    fullName: 'محمد احمد على حسن',
    bySeat: record(),
    byEmail: null,
    ...over,
  });

describe('identity matching for signup (§4.2)', () => {
  it('Case A: seat number exists, unlinked, no email on record, name matches', () => {
    expect(decide({})).toEqual({ kind: 'MATCH' });
  });

  it('Case A: the record already carries this (verified) email', () => {
    expect(
      decide({
        fullName: 'Totally different',
        bySeat: record({ universityEmail: 'student@agr.asu.edu.eg' }),
        byEmail: { id: 'record-1' },
      }),
    ).toEqual({ kind: 'MATCH' });
  });

  it('Case B for everything else', () => {
    expect(decide({ bySeat: null })).toEqual({ kind: 'NO_MATCH', issue: 'NO_RECORD' });
    expect(decide({ bySeat: record({ userId: 'someone' }) })).toEqual({
      kind: 'NO_MATCH',
      issue: 'SEAT_ALREADY_LINKED',
    });
    expect(decide({ bySeat: record({ universityEmail: 'other@agr.asu.edu.eg' }) })).toEqual({
      kind: 'NO_MATCH',
      issue: 'DETAILS_MISMATCH',
    });
    expect(decide({ fullName: 'سارة محمود' })).toEqual({
      kind: 'NO_MATCH',
      issue: 'DETAILS_MISMATCH',
    });
    expect(decide({ byEmail: { id: 'record-2' } })).toEqual({
      kind: 'NO_MATCH',
      issue: 'EMAIL_ON_OTHER_RECORD',
    });
    expect(decide({ bySeat: null, byEmail: { id: 'record-2' } })).toEqual({
      kind: 'NO_MATCH',
      issue: 'EMAIL_ON_OTHER_RECORD',
    });
  });
});
