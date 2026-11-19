import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import type { Transaction } from '@entities/transaction.entity';
import { ApiException } from '@shared/api.exception';
import { assertFound, formatMoney, readSnapshot } from '@shared/utils';
import {
  TransactionQueriesService,
  type FeedPosition,
  type LoadedTransaction,
  type TransactionSelection,
} from '@modules/transaction-queries/transaction-queries.service';
import { calendarDateAt, endOfDay, formatCalendarDate, startOfDay } from '@modules/statistics/statistics-calendar';
import { type FeedCursor, decodeFeedCursor, encodeFeedCursor, selectionDigest } from './feed-cursor';
import type {
  TransactionFeedDayTotal,
  TransactionFeedPageInfo,
  TransactionFeedSummary,
} from './dto/transaction-responses';

export interface FeedRequest {
  selection: TransactionSelection;
  timeZone: string;
  limit: number;
  cursor?: string;
  aroundId?: string;
}

export interface FeedResult<V> {
  items: V[];
  page_info: TransactionFeedPageInfo;
  summary: TransactionFeedSummary;
  day_totals: TransactionFeedDayTotal[];
}

// newest first, with whether the selection goes on past either end
interface FeedWindow {
  items: LoadedTransaction[];
  hasOlder: boolean;
  hasNewer: boolean;
}

const positionOf = (transaction: Pick<Transaction, 'timestamp' | 'id'>): FeedPosition => ({
  timestamp: transaction.timestamp,
  id: transaction.id,
});

// The feed: cursor pages, the window around a record, and the totals of the
// whole selection, read in one snapshot.
@Injectable()
export class TransactionFeedReader {
  constructor(
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly dataSource: DataSource,
  ) {}

  // Checks the cursor, then `checkAccess` (membership and filters), then the
  // around_id. `toViews` builds the items in the snapshot of the page.
  async read<V>(
    request: FeedRequest,
    checkAccess: () => Promise<void>,
    toViews: (items: LoadedTransaction[], manager: EntityManager) => Promise<V[]>,
  ): Promise<FeedResult<V>> {
    const { selection, timeZone, limit, aroundId } = request;
    const digest = selectionDigest(selection, timeZone);

    if (request.cursor !== undefined && aroundId !== undefined) {
      throw new BadRequestException([{ field: 'cursor', error: 'cursor and around_id cannot be used together' }]);
    }

    const cursor = request.cursor === undefined ? undefined : decodeFeedCursor(request.cursor, digest);

    await checkAccess();

    if (aroundId !== undefined && !isUUID(aroundId)) {
      throw new ApiException('TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND);
    }

    // One snapshot per response, not per scroll: a later page may already
    // see writes made after this one was read.
    const { window, summary, dayTotals, items } = await readSnapshot(this.dataSource, async (manager) => {
      const window =
        aroundId === undefined
          ? await this.readFeedPage(selection, limit, cursor, manager)
          : await this.readFeedAround(selection, limit, aroundId, manager);
      const items = await toViews(window.items, manager);

      // An empty first page is an empty selection: a search with no match
      // is not scanned a second time for its totals.
      if (!cursor && window.items.length === 0) {
        return { window, items, summary: { count: 0, income: 0n, expense: 0n }, dayTotals: [] };
      }

      return {
        window,
        items,
        summary: await this.transactionQueriesService.getFeedSummary(selection, manager),
        dayTotals: await this.readFeedDayTotals(selection, window.items, timeZone, manager),
      };
    });

    const first = window.items[0];
    const last = window.items[window.items.length - 1];

    return {
      items,
      page_info: {
        next_cursor: window.hasOlder
          ? encodeFeedCursor({ direction: 'older', position: positionOf(last) }, digest)
          : null,
        previous_cursor: window.hasNewer
          ? encodeFeedCursor({ direction: 'newer', position: positionOf(first) }, digest)
          : null,
      },
      summary: {
        count: summary.count,
        income: formatMoney(summary.income),
        expense: formatMoney(summary.expense),
      },
      day_totals: dayTotals,
    };
  }

  // One page from the start or from a cursor. The direction that was not
  // read is probed with a single row, so a cursor never reads more than
  // limit + 1 rows of its own direction.
  private async readFeedPage(
    selection: TransactionSelection,
    limit: number,
    cursor: FeedCursor | undefined,
    manager: EntityManager,
  ): Promise<FeedWindow> {
    const newer = cursor?.direction === 'newer';
    const page = await this.transactionQueriesService.getFeedPage(
      selection,
      { limit, ...(cursor && { [newer ? 'before' : 'after']: cursor.position }) },
      manager,
    );

    if (page.items.length === 0) {
      return { items: [], hasOlder: false, hasNewer: false };
    }

    if (!cursor) {
      return { items: page.items, hasOlder: page.hasMore, hasNewer: false };
    }

    const edge = newer
      ? { after: positionOf(page.items[page.items.length - 1]) }
      : { before: positionOf(page.items[0]) };
    const { hasMore: beyondEdge } = await this.transactionQueriesService.getFeedPage(
      selection,
      { limit: 0, ...edge },
      manager,
    );

    return newer
      ? { items: page.items, hasOlder: beyondEdge, hasNewer: page.hasMore }
      : { items: page.items, hasOlder: page.hasMore, hasNewer: beyondEdge };
  }

  // The local days of the page, each netted over the whole selection, so a
  // day split between pages has one total. Day bounds are computed here, in
  // the zone with its DST changes, and passed to MySQL as instants.
  private async readFeedDayTotals(
    selection: TransactionSelection,
    items: LoadedTransaction[],
    timeZone: string,
    manager: EntityManager,
  ): Promise<TransactionFeedDayTotal[]> {
    const days = [
      ...new Map(
        items.map((item) => {
          const day = calendarDateAt(item.timestamp, timeZone);

          return [formatCalendarDate(day), day] as const;
        }),
      ),
    ];
    const nets = await this.transactionQueriesService.getFeedIntervalNets(
      selection,
      days.map(([, day]) => ({ from: startOfDay(day, timeZone), to: endOfDay(day, timeZone) })),
      manager,
    );

    return days.map(([date], i) => ({ date, net: formatMoney(nets[i]) }));
  }

  // The record and its neighbours, read outward from its position: up to
  // limit - 1 rows on each side, never the rows between the period start and it.
  private async readFeedAround(
    selection: TransactionSelection,
    limit: number,
    transactionId: string,
    manager: EntityManager,
  ): Promise<FeedWindow> {
    const target = await this.transactionQueriesService.getOneInSpace(selection.spaceId, transactionId, manager);
    assertFound(target, 'TRANSACTION_NOT_FOUND');

    const position = await this.transactionQueriesService.findFeedPosition(selection, transactionId, manager);

    if (!position) {
      throw new ApiException('TRANSACTION_NOT_IN_FEED', HttpStatus.NOT_FOUND);
    }

    const side = limit - 1;
    const [newer, older] = [
      await this.transactionQueriesService.getFeedPage(selection, { limit: side, before: position }, manager),
      await this.transactionQueriesService.getFeedPage(selection, { limit: side, after: position }, manager),
    ];
    const newerCount = Math.min(newer.items.length, Math.max(Math.floor(side / 2), side - older.items.length));
    const olderCount = Math.min(older.items.length, side - newerCount);

    return {
      items: [...newer.items.slice(newer.items.length - newerCount), target, ...older.items.slice(0, olderCount)],
      hasNewer: newer.hasMore || newer.items.length > newerCount,
      hasOlder: older.hasMore || older.items.length > olderCount,
    };
  }
}
