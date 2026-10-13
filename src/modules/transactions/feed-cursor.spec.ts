import { BadRequestException } from '@nestjs/common';

import { FEED_CURSOR_MAX_LENGTH, decodeFeedCursor, encodeFeedCursor, selectionDigest } from './feed-cursor';
import type { TransactionSelection } from '@modules/transaction-queries/transaction-queries.service';
import { TransactionKind, TransactionType } from '@shared/enums';

const selection: TransactionSelection = {
  spaceId: 3,
  from: new Date('2026-10-01T00:00:00.000Z'),
  to: new Date('2026-10-31T23:59:59.999Z'),
  filters: { search: 'coffee', kind: TransactionKind.REGULAR },
};
const digest = selectionDigest(selection, 'Europe/Moscow');
const cursor = {
  direction: 'older' as const,
  position: { timestamp: new Date('2026-10-03T08:00:00.123Z'), id: '9b1d6c2e-1f0a-4c3b-8d2e-5a6b7c8d9e0f' },
};

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
  it('round-trips the direction and the position to the millisecond', () => {
    const encoded = encodeFeedCursor(cursor, digest);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(FEED_CURSOR_MAX_LENGTH);
    expect(decodeFeedCursor(encoded, digest)).toEqual(cursor);
  });

  it.each<[string, Partial<TransactionSelection>, string]>([
    ['space', { spaceId: 4 }, 'Europe/Moscow'],
    ['from', { from: new Date('2026-10-01T00:00:00.001Z') }, 'Europe/Moscow'],
    ['to', { to: new Date('2026-10-31T23:59:59.998Z') }, 'Europe/Moscow'],
    ['search', { filters: { search: 'tea', kind: TransactionKind.REGULAR } }, 'Europe/Moscow'],
    ['kind', { filters: { search: 'coffee' } }, 'Europe/Moscow'],
    [
      'type',
      { filters: { search: 'coffee', kind: TransactionKind.REGULAR, transactionType: TransactionType.EXPENSE } },
      'Europe/Moscow',
    ],
    ['category', { filters: { search: 'coffee', kind: TransactionKind.REGULAR, categoryId: 5 } }, 'Europe/Moscow'],
    ['wallet', { filters: { search: 'coffee', kind: TransactionKind.REGULAR, walletId: 5 } }, 'Europe/Moscow'],
    ['time zone', {}, 'Europe/Berlin'],
  ])('refuses a cursor of another %s', (_, change, timeZone) => {
    const other = selectionDigest({ ...selection, ...change }, timeZone);

    expect(errorOf(() => decodeFeedCursor(encodeFeedCursor(cursor, digest), other))).toEqual([
      { field: 'cursor', error: 'cursor does not belong to this query' },
    ]);
  });

  it('binds the search as it is matched, trimmed', () => {
    expect(
      selectionDigest(
        { ...selection, filters: { search: '  coffee ', kind: TransactionKind.REGULAR } },
        'Europe/Moscow',
      ),
    ).toBe(digest);
    expect(selectionDigest({ ...selection, filters: { search: '   ' } }, 'Europe/Moscow')).toBe(
      selectionDigest({ ...selection, filters: {} }, 'Europe/Moscow'),
    );
  });

  const valid = { v: 1, d: 'older', t: cursor.position.timestamp.getTime(), i: cursor.position.id, s: digest };

  it.each(['1970-01-01T00:00:01.000Z', '2038-01-19T03:14:07.001Z', '2038-01-19T03:14:07.999Z'])(
    'accepts a position at %s, a record a TIMESTAMP(3) column can hold',
    (timestamp) => {
      const position = { timestamp: new Date(timestamp), id: cursor.position.id };

      expect(decodeFeedCursor(encodeFeedCursor({ ...cursor, position }, digest), digest).position).toEqual(position);
    },
  );

  it.each<[string, string]>([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['an array', rawCursor([1, 'older'])],
    ['another version', rawCursor({ ...valid, v: 2 })],
    ['an unknown direction', rawCursor({ ...valid, d: 'sideways' })],
    ['a fractional time', rawCursor({ ...valid, t: 1.5 })],
    ['a time before the stored range', rawCursor({ ...valid, t: Date.parse('1970-01-01T00:00:00.999Z') })],
    ['a time after the stored range', rawCursor({ ...valid, t: Date.parse('2038-01-19T03:14:08.000Z') })],
    ['a time as text', rawCursor({ ...valid, t: String(valid.t) })],
    ['an id that is not a UUID', rawCursor({ ...valid, i: '1 OR 1=1' })],
    ['a missing digest', rawCursor({ v: 1, d: 'older', t: valid.t, i: valid.i })],
    ['an extra key', rawCursor({ ...valid, x: 1 })],
    ['too long', 'A'.repeat(FEED_CURSOR_MAX_LENGTH + 1)],
  ])('refuses a cursor that is %s', (_, value) => {
    expect(errorOf(() => decodeFeedCursor(value, digest))).toEqual([{ field: 'cursor', error: 'cursor is malformed' }]);
  });
});
