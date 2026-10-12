import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

import type { FeedPosition, TransactionSelection } from '@modules/transaction-queries/transaction-queries.service';
import { TIMESTAMP_MAX, TIMESTAMP_MIN } from '@shared/decorators/is-iso-date.decorator';

export const FEED_CURSOR_VERSION = 1;
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
  t: number;
  i: string;
  s: string;
}

// Not a secret: a cursor only moves within a selection the member may read,
// so the digest just keeps a cursor from being replayed on another query.
export const selectionDigest = (selection: TransactionSelection, timeZone: string): string => {
  const { spaceId, from, to, filters = {} } = selection;

  return createHash('sha256')
    .update(
      JSON.stringify([
        spaceId,
        from.getTime(),
        to.getTime(),
        timeZone,
        filters.search?.trim() || null,
        filters.transactionType ?? null,
        filters.kind ?? null,
        filters.categoryId ?? null,
        filters.walletId ?? null,
      ]),
    )
    .digest('base64url');
};

export const encodeFeedCursor = (cursor: FeedCursor, digest: string): string => {
  const payload: CursorPayload = {
    v: FEED_CURSOR_VERSION,
    d: cursor.direction,
    t: cursor.position.timestamp.getTime(),
    i: cursor.position.id,
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
  Number.isSafeInteger(payload.t) &&
  payload.t >= TIMESTAMP_MIN.getTime() &&
  payload.t <= TIMESTAMP_MAX.getTime() &&
  typeof payload.i === 'string' &&
  isUUID(payload.i) &&
  typeof payload.s === 'string';

export const decodeFeedCursor = (cursor: string, digest: string): FeedCursor => {
  const payload = parsePayload(cursor);

  if (!payload || payload.v !== FEED_CURSOR_VERSION || !isValidPayload(payload)) {
    throw cursorError('cursor is malformed');
  }

  if (payload.s !== digest) {
    throw cursorError('cursor does not belong to this query');
  }

  return { direction: payload.d, position: { timestamp: new Date(payload.t), id: payload.i } };
};
