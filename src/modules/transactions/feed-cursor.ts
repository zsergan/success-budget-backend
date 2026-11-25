import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';

import type { FeedPosition, TransactionSelection } from '@modules/transaction-queries/transaction-queries.service';
import { assignmentKey } from '@modules/transaction-queries/assignment-filter';
import { isCalendarDate } from '@shared/utils';

// 2: positions by date and ordering key; cursors of format 1 held instants
export const FEED_CURSOR_VERSION = 2;
export const FEED_CURSOR_MAX_LENGTH = 256;

// older: records after the position in the history order; newer: before it
export type FeedDirection = 'older' | 'newer';

export interface FeedCursor {
  direction: FeedDirection;
  position: FeedPosition;
}

interface CursorPayload {
  v: number;
  d: FeedDirection;
  t: string;
  k: string;
  s: string;
}

// an ordering key: a BIGINT UNSIGNED from 1, as a decimal string
const ORDER_KEY = /^[1-9]\d{0,19}$/;
const ORDER_KEY_MAX = 18446744073709551615n;

// Not a secret: a cursor only moves within a selection the member may read,
// so the digest just keeps a cursor from being replayed on another query.
export const selectionDigest = (selection: TransactionSelection): string => {
  const { spaceId, fromDate, toDate, filters = {} } = selection;
  const parts: unknown[] = [
    spaceId,
    fromDate,
    toDate,
    filters.search?.trim() || null,
    filters.transactionType ?? null,
    filters.kind ?? null,
    filters.categoryId ?? null,
    filters.assignment ? assignmentKey(filters.assignment) : null,
  ];

  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
};

export const encodeFeedCursor = (cursor: FeedCursor, digest: string): string => {
  const payload: CursorPayload = {
    v: FEED_CURSOR_VERSION,
    d: cursor.direction,
    t: cursor.position.date,
    k: cursor.position.orderKey,
    s: digest,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64url');
};

const cursorError = (error: string) => new BadRequestException([{ field: 'cursor', error }]);

const parsePayload = (cursor: string): CursorPayload | null => {
  if (cursor.length > FEED_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as CursorPayload)
      : null;
  } catch {
    return null;
  }
};

const isValidPayload = (payload: CursorPayload): boolean =>
  Object.keys(payload).length === 5 &&
  (payload.d === 'older' || payload.d === 'newer') &&
  typeof payload.t === 'string' &&
  isCalendarDate(payload.t) &&
  typeof payload.k === 'string' &&
  ORDER_KEY.test(payload.k) &&
  BigInt(payload.k) <= ORDER_KEY_MAX &&
  typeof payload.s === 'string';

export const decodeFeedCursor = (cursor: string, digest: string): FeedCursor => {
  const payload = parsePayload(cursor);

  if (!payload || payload.v !== FEED_CURSOR_VERSION || !isValidPayload(payload)) {
    throw cursorError('cursor is malformed');
  }

  if (payload.s !== digest) {
    throw cursorError('cursor does not belong to this query');
  }

  return { direction: payload.d, position: { date: payload.t, orderKey: payload.k } };
};
