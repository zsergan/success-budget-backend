import { BadRequestException } from '@nestjs/common';

import { FEED_CURSOR_MAX_LENGTH, decodeFeedCursor, encodeFeedCursor, selectionDigest } from './feed-cursor';
import { AssignmentKind } from '@shared/enums';
import type { TransactionSelection } from '@modules/transaction-queries/transaction-queries.service';
import { TransactionKind, TransactionType } from '@shared/enums';

const selection: TransactionSelection = {
  spaceId: 3,
  fromDate: '2026-10-01',
  toDate: '2026-10-31',
  filters: { search: 'coffee', kind: TransactionKind.REGULAR },
};
const digest = selectionDigest(selection);
const cursor = { direction: 'older' as const, position: { date: '2026-10-03', orderKey: '4210' } };

const SPACE = { kind: AssignmentKind.SPACE } as const;

const rawCursor = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');
const errorOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return ((error as BadRequestException).getResponse() as { message: unknown }).message;
  }

  throw new Error('expected an error');
};

describe('feed cursor', () => {
  it('round-trips the direction and the position', () => {
    const encoded = encodeFeedCursor(cursor, digest);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(FEED_CURSOR_MAX_LENGTH);
    expect(decodeFeedCursor(encoded, digest)).toEqual(cursor);
  });

  it('keeps every digit of an ordering key beyond the safe integers', () => {
    const position = { date: '9999-12-31', orderKey: '18446744073709551615' };
    const encoded = encodeFeedCursor({ ...cursor, position }, digest);

    expect(encoded.length).toBeLessThanOrEqual(FEED_CURSOR_MAX_LENGTH);
    expect(decodeFeedCursor(encoded, digest).position).toEqual(position);
  });

  it.each<[string, Partial<TransactionSelection>]>([
    ['space', { spaceId: 4 }],
    ['from date', { fromDate: '2026-10-02' }],
    ['to date', { toDate: '2026-10-30' }],
    ['search', { filters: { search: 'tea', kind: TransactionKind.REGULAR } }],
    ['kind', { filters: { search: 'coffee' } }],
    [
      'type',
      { filters: { search: 'coffee', kind: TransactionKind.REGULAR, transactionType: TransactionType.EXPENSE } },
    ],
    ['category', { filters: { search: 'coffee', kind: TransactionKind.REGULAR, categoryId: 5 } }],
    ['assignment', { filters: { search: 'coffee', kind: TransactionKind.REGULAR, assignment: SPACE } }],
  ])('refuses a cursor of another %s', (_, change) => {
    const other = selectionDigest({ ...selection, ...change });

    expect(errorOf(() => decodeFeedCursor(encodeFeedCursor(cursor, digest), other))).toEqual([
      { field: 'cursor', error: 'cursor does not belong to this query' },
    ]);
  });

  it('binds the search as it is matched, trimmed', () => {
    expect(selectionDigest({ ...selection, filters: { search: '  coffee ', kind: TransactionKind.REGULAR } })).toBe(
      digest,
    );
    expect(selectionDigest({ ...selection, filters: { search: '   ' } })).toBe(
      selectionDigest({ ...selection, filters: {} }),
    );
  });

  it('binds a cursor to its assignment filter', () => {
    const lena = { ...selection, filters: { assignment: { kind: AssignmentKind.MEMBER, userId: 31 } as const } };
    const other = { ...selection, filters: { assignment: { kind: AssignmentKind.MEMBER, userId: 32 } as const } };

    expect(selectionDigest(lena)).not.toBe(selectionDigest(other));
    expect(selectionDigest(lena)).not.toBe(selectionDigest({ ...selection, filters: { assignment: SPACE } }));
    expect(selectionDigest(lena)).not.toBe(selectionDigest({ ...selection, filters: {} }));
  });

  const valid = { v: 2, d: 'older', t: cursor.position.date, k: cursor.position.orderKey, s: digest };

  it('refuses a cursor issued before the calendar-date release, whatever it holds', () => {
    const before = rawCursor({
      v: 1,
      d: 'older',
      t: Date.parse('2026-10-03T08:00:00Z'),
      i: '9b1d6c2e-1f0a-4c3b-8d2e-5a6b7c8d9e0f',
      s: digest,
    });

    expect(errorOf(() => decodeFeedCursor(before, digest))).toEqual([
      { field: 'cursor', error: 'cursor is malformed' },
    ]);
  });

  it.each<[string, string]>([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['an array', rawCursor([2, 'older'])],
    ['another version', rawCursor({ ...valid, v: 3 })],
    ['an unknown direction', rawCursor({ ...valid, d: 'sideways' })],
    ['a date with a time', rawCursor({ ...valid, t: '2026-10-03T00:00:00Z' })],
    ['an invalid day', rawCursor({ ...valid, t: '2026-02-29' })],
    ['a date as a number', rawCursor({ ...valid, t: Date.parse('2026-10-03') })],
    ['an ordering key of zero', rawCursor({ ...valid, k: '0' })],
    ['an ordering key with a sign', rawCursor({ ...valid, k: '-5' })],
    ['an ordering key as a number', rawCursor({ ...valid, k: 4210 })],
    ['an ordering key beyond BIGINT UNSIGNED', rawCursor({ ...valid, k: '18446744073709551616' })],
    ['an ordering key that is SQL', rawCursor({ ...valid, k: '1 OR 1=1' })],
    ['a missing digest', rawCursor({ v: 2, d: 'older', t: valid.t, k: valid.k })],
    ['an extra key', rawCursor({ ...valid, x: 1 })],
    ['too long', 'A'.repeat(FEED_CURSOR_MAX_LENGTH + 1)],
  ])('refuses a cursor that is %s', (_, value) => {
    expect(errorOf(() => decodeFeedCursor(value, digest))).toEqual([{ field: 'cursor', error: 'cursor is malformed' }]);
  });
});
