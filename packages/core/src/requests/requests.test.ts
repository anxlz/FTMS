import { describe, expect, it } from 'vitest';
import { nameConsistentWith } from '../students/names';
import {
  CreateGroupSwapRequestSchema,
  CreateTicketRequestSchema,
  RejectGroupSwapRequestSchema,
  TicketMessageRequestSchema,
} from './contracts';
import {
  GROUP_SWAP_EVENTS,
  GROUP_SWAP_STATUSES,
  GROUP_SWAP_TRANSITIONS,
  isOpenGroupSwap,
  nextGroupSwapStatus,
  ticketStatusOfSwap,
} from './group-swap';

describe('group-swap state machine (§14)', () => {
  it('needs the counterpart, then the faculty', () => {
    expect(nextGroupSwapStatus('PENDING_COUNTERPART', 'COUNTERPART_ACCEPT')).toBe(
      'PENDING_FACULTY',
    );
    expect(nextGroupSwapStatus('PENDING_FACULTY', 'FACULTY_APPROVE')).toBe('APPROVED');
    // Faculty cannot decide before the counterpart has consented.
    expect(nextGroupSwapStatus('PENDING_COUNTERPART', 'FACULTY_APPROVE')).toBeNull();
    expect(nextGroupSwapStatus('PENDING_COUNTERPART', 'FACULTY_REJECT')).toBeNull();
    // The counterpart decides once.
    expect(nextGroupSwapStatus('PENDING_FACULTY', 'COUNTERPART_ACCEPT')).toBeNull();
    expect(nextGroupSwapStatus('PENDING_FACULTY', 'COUNTERPART_REJECT')).toBeNull();
  });

  it('ends in a final state from which nothing moves', () => {
    for (const status of [
      'COUNTERPART_REJECTED',
      'FACULTY_REJECTED',
      'APPROVED',
      'WITHDRAWN',
      'CANCELLED',
    ] as const) {
      expect(isOpenGroupSwap(status)).toBe(false);
      for (const event of GROUP_SWAP_EVENTS) expect(nextGroupSwapStatus(status, event)).toBeNull();
      expect(ticketStatusOfSwap(status)).toBe('CLOSED');
    }
  });

  it('lets the requester withdraw and the system invalidate only open requests', () => {
    for (const status of GROUP_SWAP_STATUSES) {
      const open = isOpenGroupSwap(status);
      expect(nextGroupSwapStatus(status, 'WITHDRAW') !== null).toBe(open);
      expect(nextGroupSwapStatus(status, 'INVALIDATE') !== null).toBe(open);
    }
    expect(Object.keys(GROUP_SWAP_TRANSITIONS).sort()).toEqual([...GROUP_SWAP_STATUSES].sort());
    expect(ticketStatusOfSwap('PENDING_COUNTERPART')).toBe('OPEN');
    expect(ticketStatusOfSwap('PENDING_FACULTY')).toBe('IN_PROGRESS');
  });
});

describe('request forms', () => {
  it('normalizes the counterpart seat number and drops empty optional text', () => {
    const parsed = CreateGroupSwapRequestSchema.parse({
      targetGroupId: '01900000-0000-7000-8000-000000000001',
      counterpartSeatNumber: ' ab-١٢٣ ',
      counterpartName: '   ',
    });
    expect(parsed).toEqual({
      targetGroupId: '01900000-0000-7000-8000-000000000001',
      counterpartSeatNumber: 'AB-123',
      counterpartName: undefined,
      note: undefined,
    });
  });

  it('requires a faculty rejection reason', () => {
    expect(RejectGroupSwapRequestSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(RejectGroupSwapRequestSchema.safeParse({}).success).toBe(false);
    expect(RejectGroupSwapRequestSchema.parse({ reason: ' Groups are full ' })).toEqual({
      reason: 'Groups are full',
    });
  });

  it('creates complaints and suggestions only; swaps have their own form', () => {
    const base = { subject: 'Bus was late', description: 'The bus left 30 minutes late.' };
    expect(CreateTicketRequestSchema.safeParse({ ...base, category: 'COMPLAINT' }).success).toBe(
      true,
    );
    expect(CreateTicketRequestSchema.safeParse({ ...base, category: 'GROUP_SWAP' }).success).toBe(
      false,
    );
    expect(TicketMessageRequestSchema.parse({ body: ' Hi ' })).toEqual({
      body: 'Hi',
      internal: false,
    });
    expect(TicketMessageRequestSchema.parse({ body: 'x', internal: 'true' }).internal).toBe(true);
  });
});

describe('counterpart name check (§14.1)', () => {
  const full = 'محمد أحمد علي حسن';
  it('accepts the full name, spelling variants, and two or more words in order', () => {
    expect(nameConsistentWith('محمد احمد علي حسن', full)).toBe(true);
    expect(nameConsistentWith('محمد حسن', full)).toBe(true);
    expect(nameConsistentWith('محمد  أحمد', full)).toBe(true);
  });
  it('rejects a single word, wrong order or another name', () => {
    expect(nameConsistentWith('محمد', full)).toBe(false);
    expect(nameConsistentWith('حسن محمد', full)).toBe(false);
    expect(nameConsistentWith('أحمد سعيد', full)).toBe(false);
    expect(nameConsistentWith('', full)).toBe(false);
  });
});
