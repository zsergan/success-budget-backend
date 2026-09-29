# Statistics API contract

Contract for the mobile Stats tab: three independently loaded blocks
(Summary, Trend, Breakdown) for one space, plus history filters that let a
user re-check every number in the transaction list. This document is the
source of truth for the backend implementation and the mobile integration;
the rules below apply to all three endpoints identically.

Anything marked _open_ needs sign-off before the stage that implements it.

## Implementation status

| Part                                                           | Status      |
| -------------------------------------------------------------- | ----------- |
| Routes, query parameters, validation, `as_of`, access check    | implemented |
| `period` metadata, `currency`                                  | implemented |
| Summary `income`, `expense`, `net`, `transactions_count`       | implemented |
| Summary `previous`, `change`                                   | implemented |
| Trend `totals`, `granularity`, `buckets`                       | implemented |
| Summary `has_any_transactions`, `last_transaction_date`        | implemented |
| Breakdown `total`, `by_category`, `by_wallet`, Other           | implemented |
| History filters `category_id`, `wallet_id`, `transaction_type` | planned     |

## Endpoints

All routes are under `/api/v1`, require the bearer token and membership in
the space; a non-member gets the usual `403 FORBIDDEN_SPACE`.

| Method | Route                                      | Block                                                 |
| ------ | ------------------------------------------ | ----------------------------------------------------- |
| `GET`  | `/spaces/:spaceId/statistics/summary`      | Income, Expense, Net, comparison with previous period |
| `GET`  | `/spaces/:spaceId/statistics/trend`        | Income and Expense per bucket                         |
| `GET`  | `/spaces/:spaceId/statistics/breakdown`    | Expenses by category **and** by wallet, with Other    |
| `GET`  | `/spaces/:spaceId/transactions` (extended) | History filtered by category or wallet                |

The three blocks take the same query parameters and select transactions by
the same rules. Each one fails on its own with an ordinary HTTP error (400,
403, 5xx), so the screen can show a local error and retry just that block.
Breakdown returns both groupings at once: switching the By category / By
wallet tab never sends a request.

## Calculation rules

1. **One space.** Statistics cover the selected space only: every wallet of
   the space, including soft-deleted ones. There is no cross-space total.
2. **Space currency.** All amounts are in `Space.currency`, returned as
   `currency` (its code). There is no FX conversion; wallets and
   transactions have no currency of their own.
3. **Income excludes starting balances.** A transaction on the system
   category (`Category.is_system = 1`, "Initial balance") is excluded from
   every statistic: sums, counts, trend, breakdown,
   `last_transaction_date`. The exclusion is by the system category, not by
   name or amount.
4. **Type comes from the transaction.** A transaction counts as income or
   expense by `Transaction.transaction_type`, never by its category's type.
5. **Net = Income − Expense.** Income and expense are non-negative sums;
   net is signed. Net is not a wallet balance.
6. **History is kept.** Transactions on archived categories and on
   soft-deleted wallets are counted everywhere. An archived category keeps
   its own row in the breakdown (`is_archived: true`); deleted wallets are
   merged into one service group, `deleted_wallets`, that opens no history.
7. **No future transactions.** A transaction with `timestamp` after `as_of`
   is not part of any sum or count, even inside the selected period. The
   period's actual range ends at `min(period end, as_of)`.
8. **Zero is not empty.** `"0.00"` does not mean there were no
   transactions: zero-amount transactions are valid, and income may equal
   expense. Summary and Trend totals pair every sum with a `count`; "no
   data" states are decided by counts, never by amounts. The breakdown is
   the one exception: it draws shares, so it lists only groups with a
   positive sum.
9. **Exact money.** Sums are computed in integer cents (`SUM` strings parsed
   with `parseMoney`, arithmetic on `bigint`, `formatMoney` for output), as
   in `src/shared/utils/money.ts`. No amount is ever a JS `number` on the way.
10. **One time boundary.** `as_of` bounds the transactions of every block
    in a load cycle (see Consistency model).

## Query parameters

Shared by all three blocks.

| Param         | Type                                    | Required                  | Meaning                                                                 |
| ------------- | --------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `period`      | `week` \| `month` \| `year` \| `custom` | yes                       | Period kind                                                             |
| `time_zone`   | IANA name (`Europe/Moscow`, `UTC`)      | yes                       | The device's zone; defines days, weeks, months and years                |
| `anchor_date` | `YYYY-MM-DD`                            | no; not with `custom`     | Any day inside the wanted week/month/year; default: `as_of`'s local day |
| `from_date`   | `YYYY-MM-DD`                            | with `custom`, only there | First local day, inclusive                                              |
| `to_date`     | `YYYY-MM-DD`                            | with `custom`, only there | Last local day, inclusive                                               |
| `as_of`       | ISO 8601 date-time with `Z` or offset   | no; default: server time  | Time boundary of the load cycle; echoed as `period.as_of`               |

Validation errors are `400` with the standard `message: [{ field, error }]`
shape:

| Case                                                                                        | `field`                 |
| ------------------------------------------------------------------------------------------- | ----------------------- |
| `period` missing, unknown or repeated                                                       | `period`                |
| `time_zone` missing, unknown or a fixed offset (`+03:00`: it ignores DST)                   | `time_zone`             |
| a date that is not a real `YYYY-MM-DD` calendar date, empty or repeated                     | that date               |
| `anchor_date` with `custom`; `from_date`/`to_date` with another period or missing on custom | that date               |
| `from_date` after `to_date`; a custom period over **366** days (_open_: cap)                | `to_date`               |
| `as_of` without `Z`/offset, outside the `TIMESTAMP` range, or in the future (below)         | `as_of`                 |
| a period reaching outside the MySQL `TIMESTAMP` range (1970–2038)                           | `anchor_date`/`to_date` |
| any other parameter                                                                         | its name                |

`as_of` is in the future when it is more than **60 seconds** ahead of the
server clock; that margin absorbs device clock drift. A value within the
margin is used exactly as sent. An `as_of` after the selected period's end
simply makes the period `past`.

## Periods

Boundaries are computed as local dates in `time_zone`, then converted to
instants. Calendar arithmetic (weeks, month lengths, leap years, year
boundaries) is done on dates without a zone; only the final day bounds meet
the zone, so DST never shifts a period or a bucket by an hour.

| `period` | Local range                                                    |
| -------- | -------------------------------------------------------------- |
| `week`   | Monday through Sunday containing the anchor day                |
| `month`  | First through last day of the calendar month of the anchor day |
| `year`   | January 1 through December 31 of the anchor day's year         |
| `custom` | `from_date` through `to_date`                                  |

A local day starts at its first existing instant (midnight, or the end of a
DST gap that skips midnight) and ends right before the next day starts, so
days are 23, 24 or 25 hours long.

```ts
interface StatisticsPeriod {
  type: 'week' | 'month' | 'year' | 'custom';
  time_zone: string; // canonical IANA name
  start_date: string; // local YYYY-MM-DD, inclusive
  end_date: string; // local YYYY-MM-DD, inclusive
  from: string; // ISO instant (UTC, ms) of start_date's first moment
  to: string; // ISO instant of end_date's last millisecond
  as_of: string; // the applied time boundary
  actual_to: string | null; // min(to, as_of); null when state = 'future'
  state: 'past' | 'current' | 'future';
}
```

- `past`: `as_of > to`; `actual_to = to`.
- `current`: `from <= as_of <= to`; `actual_to = as_of`.
- `future`: `as_of < from`; `actual_to = null`, every sum is `"0.00"` and
  every count `0`.

Transactions are selected with `from <= timestamp <= actual_to`, inclusive
on both ends like the history filter, so `from` and `actual_to` can be
passed to `GET /transactions` unchanged.

### Previous period

Summary compares a standard period with the previous one of the same kind:
the preceding week, month or year. **Custom and `future` periods have no
comparison** (`previous` and `change` are `null`).

A `current` period is compared like-for-like: the previous period is cut at
the same position, at the same local wall-clock time as `as_of` (September 1
to 28 at 15:00 against August 1 to 28 at 15:00, not all of August).

| `period` | Same position                                                         |
| -------- | --------------------------------------------------------------------- |
| `week`   | Same weekday                                                          |
| `month`  | Same day of month, clamped to the previous month's last day (31 → 30) |
| `year`   | Same month and day, Feb 29 → Feb 28                                   |

A `past` period is compared with the whole previous period.

The response carries the comparison bounds (`previous.start_date`,
`end_date`, `from`, `to`, `actual_to`), not a caption: texts such as "vs Aug
1–28" are composed and localized by the client.

## Money and percentages

- Money is a decimal **string** with exactly two decimals and `-` only for
  negatives: `"1234.50"`, `"0.00"`, `"-510.50"`. No thousands separator, no
  currency sign. (Older endpoints return numbers; the new API does not.)
- Sums may exceed the per-amount input range `99999999.99`.
- Percentages are JSON **numbers** with one decimal, computed from cents by
  `roundPercentToTenth` (halves toward +∞). The client may round further for
  display.

| Field               | Formula                                     | Zero base |
| ------------------- | ------------------------------------------- | --------- |
| `change.*.delta`    | `current − previous` (money string, signed) | —         |
| `change.*.percent`  | `(current − previous) / \|previous\| × 100` | `null`    |
| breakdown `percent` | `amount / total_amount × 100`               | —         |

`percent` divides by `|previous|`, so a rise of a negative net is positive.
`null` is the design's "No comparison". Breakdown percents are rounded one
by one and may not add up to exactly `100.0`.

## Summary

`GET /spaces/:spaceId/statistics/summary`

```ts
interface MoneyCount {
  amount: string;
  count: number;
}

interface Change {
  delta: string;
  percent: number | null;
}

interface StatisticsSummary {
  period: StatisticsPeriod;
  currency: string;
  income: MoneyCount;
  expense: MoneyCount;
  net: string;
  transactions_count: number; // income.count + expense.count
  previous: {
    start_date: string; // the whole previous period, local dates
    end_date: string;
    from: string;
    to: string;
    actual_to: string; // the like-for-like cut of a current period, otherwise to
    income: MoneyCount; // over from..actual_to
    expense: MoneyCount;
    net: string;
    transactions_count: number;
  } | null; // null for custom and future periods
  change: { income: Change; expense: Change; net: Change } | null; // null with previous
  // any statistics transaction up to as_of, in any period
  has_any_transactions: boolean;
  // local date (in time_zone) of the latest one; null exactly when has_any_transactions is false
  last_transaction_date: string | null;
}
```

Screen states come from counts and dates, never from amounts:

| Condition                               | State                                                    |
| --------------------------------------- | -------------------------------------------------------- |
| `period.state = 'future'`               | The period has not started; checked first                |
| `has_any_transactions = false`          | Nothing to report yet (first run)                        |
| `transactions_count = 0`, date not null | Nothing in this period; "Your last one was on …", "Open" |
| `transactions_count > 0`                | Data, even when every amount is `"0.00"`                 |
| `change.x.percent = null`               | No comparison for that figure                            |
| `by_category.source_count = 0`          | Breakdown shows "No expenses in this period"             |

Surplus / Deficit / Balanced is the sign of `net`, decided by the client.

## Trend

`GET /spaces/:spaceId/statistics/trend`

| `period`             | `granularity` | Buckets                                                |
| -------------------- | ------------- | ------------------------------------------------------ |
| `week`               | `day`         | 7                                                      |
| `month`              | `week`        | 4–6 calendar weeks from Monday, clipped to the month   |
| `year`               | `month`       | 12                                                     |
| `custom` ≤ 14 days   | `day`         | one per day                                            |
| `custom` 15–92 days  | `week`        | weeks from Monday, first and last clipped to the range |
| `custom` 93–366 days | `month`       | calendar months, first and last clipped to the range   |

```ts
interface TrendBucket {
  key: string; // stable id of the bucket, see below
  start_date: string; // local dates, inclusive, clipped to the period
  end_date: string;
  from: string; // exact instants of start_date's first and end_date's last moment
  to: string;
  state: 'past' | 'current' | 'future';
  income: string | null; // null only when state = 'future'
  expense: string | null;
}

interface StatisticsTrend {
  period: StatisticsPeriod;
  currency: string;
  // control sums, equal to Summary income/expense of the same cycle
  totals: { income: MoneyCount; expense: MoneyCount };
  granularity: 'day' | 'week' | 'month';
  buckets: TrendBucket[]; // chronological, covering the whole period
}
```

Buckets always cover the whole period, so the axis is stable. A `future`
bucket has `null` values (no bars); a past bucket with no transactions has
`"0.00"` values (a baseline mark). A `current` bucket keeps its full
`from`/`to` but sums only up to `as_of`. The buckets add up exactly to
`totals`; `totals` also carry the counts the buckets do not.

`key` is the ISO notation of the calendar unit the bucket starts in: `day`
`2026-09-28`, `week` `2026-W40` (ISO week-numbering year, so the week of
2025-12-29 is `2026-W01`), `month` `2026-09`. A key is unique within a
response and the same bucket gets the same key on every request, so the
client can keep a selected bar across reloads. Bar labels are built by the
client from `start_date`/`end_date`.

In a `future` period every bucket is `future` and `totals` are zero with
zero counts; together with `period.state` this tells "not started yet"
apart from "no transactions".

## Breakdown

`GET /spaces/:spaceId/statistics/breakdown` — expenses only. Both groupings
come in one response, ready to draw: the client repeats neither the money
arithmetic nor the grouping.

```ts
interface BreakdownItem {
  kind: 'category' | 'wallet' | 'deleted_wallets' | 'other';
  key: string; // stable: 'category:12', 'wallet:3', 'deleted_wallets', 'other'
  id: number | null; // the category or wallet id; null for service groups
  name: string | null; // null for service groups: the client names them
  icon: CategoryIcon | null; // categories only
  color: AppColor | null; // Category.color, Wallet.design; null for service groups
  amount: string;
  percent: number; // of total_amount, one decimal
  is_archived: boolean; // archived category
  opens_history: boolean; // true for categories (archived too) and wallets
}

interface DeletedWalletsItem extends BreakdownItem {
  kind: 'deleted_wallets';
  wallets_count: number;
}

interface OtherItem extends BreakdownItem {
  kind: 'other';
  children: BreakdownItem[]; // the folded groups, sorted, inline
}

interface CategoryBreakdown {
  total_amount: string;
  source_count: number; // categories with a positive sum
  primary_items: BreakdownItem[]; // kind 'category'
  other: OtherItem | null;
}

interface WalletBreakdown {
  total_amount: string;
  source_count: number; // real wallets with a positive sum, deleted ones included
  primary_items: BreakdownItem[]; // kind 'wallet', active wallets only
  deleted_wallets: DeletedWalletsItem | null;
  other: OtherItem | null;
}

interface StatisticsBreakdown {
  period: StatisticsPeriod;
  currency: string;
  // control sum, equal to Summary expense of the same cycle
  total: MoneyCount;
  by_category: CategoryBreakdown;
  by_wallet: WalletBreakdown;
}
```

- Sums per category and per wallet are computed in SQL (`GROUP BY`); only
  the groups reach Node.js, never the transactions.
- `total_amount` of each grouping is the sum of all its groups, so the
  items and Other add up to it exactly.
- Segments are drawn in this order: `primary_items`, then
  `deleted_wallets`, then `other`. Other is always last, even when it is
  larger than a primary item.
- The center of the donut shows `source_count` ("10 categories"), not the
  number of segments. Expanding Other changes neither the donut, the total
  nor the count: its `children` are already in the response.
- Category name, icon and color are the current values. Service groups
  have no color token; the client uses its own, distinguishable neutral
  shades for `deleted_wallets` and `other`.
- Other is not a category: it has no id and opens no history. A real
  category named "Other" is `kind: 'category'` with an id; the two are
  told apart by `kind`, never by name.

### Other

One pure function (`foldGroups`) serves both groupings:

1. Take the sums per group for the period; drop groups with a zero sum.
2. Sort by sum descending; ties by id ascending.
3. Keep as primary at most **6** groups whose share of the total is at
   least **3%**. The share is checked on exact cents, before rounding.
4. Fold the rest into Other: its `amount` is the exact sum of its children
   and its `percent` is computed from that sum, so the children's rounded
   percents may add up to 9.4 while Other shows 9.5.
5. If no group reaches 3%, the largest one stays primary and the rest is
   folded.
6. With nothing left over there is no Other (`other: null`).

Children are sorted like primary items; their percents are of the whole
`total_amount`, not of Other. The 3% threshold (about 11° of the circle)
and the limit of 6 are backend constants, not user settings; neither is
taken from the mock-up data.

| Distribution           | Result                                |
| ---------------------- | ------------------------------------- |
| One category, 100%     | One full ring, no Other               |
| 50%, 30%, 20%          | Three primary groups                  |
| 98%, 1%, 1%            | The largest group and Other of 2%     |
| Ten mock-up categories | Six primary groups, four inside Other |
| Eight about equal      | Six primary groups, two inside Other  |

**Wallets.** The same function, with one service group added: all
soft-deleted wallets with a positive sum form `deleted_wallets`. It is
outside the threshold and never folded into Other, and it is `null` when
its sum is zero. To stay within seven segments, primary wallets are
limited to **5** when `deleted_wallets` is present and 6 otherwise. The
threshold is still measured against the whole `total_amount`, deleted
wallets included.

## Consistency model

A **load cycle** is one set of Summary, Trend and Breakdown requests for the
same period. It starts when the screen opens, the period changes or the user
refreshes.

1. The client takes the device time once, as an instant with `Z`, and sends
   it as `as_of` with identical parameters to all three blocks.
2. Retrying a failed block reuses the cycle's parameters and `as_of`.
3. Each response echoes the applied `period`; within a cycle all three must
   be equal.
4. `as_of` bounds transaction timestamps, not database state. The requests
   are separate reads with **no shared snapshot**: a transaction created,
   edited or deleted by any member between them (for example one backdated
   to the selected period) can show up in only some of the responses. The
   API does not promise an atomic view under concurrent editing.
5. To detect that, the client compares the control sums with Summary, both
   `amount` and `count`: `trend.totals.income`/`expense` with
   `summary.income`/`expense`, and `breakdown.total` with `summary.expense`.
6. On a mismatch the client starts **one** new cycle with a new `as_of`. If
   the new cycle still disagrees, it shows the new data as they are and
   does not reload again on its own; the next manual refresh or period
   change starts over.
7. If `as_of` is rejected as in the future (device clock far ahead), the
   client repeats the cycle once without `as_of` and uses the `period.as_of`
   of the first response for the blocks it has not requested yet.

## History filters (drill-down)

`GET /spaces/:spaceId/transactions` gains optional query parameters:

| Param              | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `category_id`      | Only this category's transactions (archived allowed, system rejected) |
| `wallet_id`        | Only this wallet's transactions (active wallets only)                 |
| `transaction_type` | `income` or `expense`                                                 |

`category_id` and `wallet_id` are mutually exclusive (400). A foreign,
missing or system category, or a foreign, missing or deleted wallet, is the
existing `403` of that resource. A breakdown row opens:

```
GET /spaces/:spaceId/transactions?from={period.from}&to={period.actual_to}&category_id={id}
GET /spaces/:spaceId/transactions?from={period.from}&to={period.actual_to}&wallet_id={id}&transaction_type=expense
```

`from`/`to` are exact instants, so the history uses the statistics bounds
whatever the server's zone, and its rows add up to the row's `amount`.

## Worked examples

Fixed test clock: **`as_of = 2026-09-28T12:00:00.000Z`** (Monday, 15:00 in
`Europe/Moscow`, UTC+3 without DST). The data set, amounts and names are
test fixtures only; nothing here (and nothing in the design mock-ups) is an
application constant.

Space currency `EUR`. Wallets: `1` Card, `2` Cash, `4` Savings (active),
`3` Old card (deleted). Categories: `10` Groceries, `11` Restaurants, `12`
Transport, `13` Health, `14` Gifts (archived), `15` Pets, `16` Fees, `20`
Salary (income), `99` Initial balance (system).

| Id  | Local time (MSK) | Type    | Category        | Wallet | Amount  | Note                               |
| --- | ---------------- | ------- | --------------- | ------ | ------- | ---------------------------------- |
| A1  | 2026-08-03 10:00 | income  | Salary          | 1      | 3000.00 |                                    |
| A2  | 2026-08-10 12:00 | expense | Groceries       | 1      | 200.00  |                                    |
| A3  | 2026-08-20 18:00 | expense | Restaurants     | 2      | 100.00  |                                    |
| A4  | 2026-08-29 10:00 | expense | Groceries       | 1      | 300.00  | after the like-for-like cut        |
| S0  | 2026-09-01 09:00 | income  | Initial balance | 4      | 1000.00 | excluded: system category          |
| S1  | 2026-09-01 10:00 | income  | Salary          | 1      | 3000.00 |                                    |
| S2  | 2026-09-02 19:30 | expense | Groceries       | 1      | 450.25  |                                    |
| S3  | 2026-09-05 13:00 | expense | Restaurants     | 2      | 120.00  |                                    |
| S4  | 2026-09-09 08:00 | expense | Transport       | 1      | 60.00   |                                    |
| S5  | 2026-09-12 20:00 | expense | Gifts           | 3      | 80.00   | archived category, deleted wallet  |
| S6  | 2026-09-15 11:00 | expense | Health          | 3      | 25.50   | deleted wallet                     |
| S7  | 2026-09-18 16:00 | expense | Pets            | 2      | 15.00   |                                    |
| S8  | 2026-09-21 09:00 | expense | Fees            | 1      | 0.00    | zero amount                        |
| S9  | 2026-09-27 23:30 | expense | Groceries       | 1      | 49.75   | `2026-09-27T20:30Z`                |
| S10 | 2026-09-28 00:30 | expense | Transport       | 2      | 10.00   | `2026-09-27T21:30Z`: Sep 27 in UTC |
| F1  | 2026-09-29 10:00 | expense | Groceries       | 1      | 500.00  | after `as_of`: excluded            |

### Example 1 — current month

`GET /statistics/summary?period=month&time_zone=Europe/Moscow&as_of=2026-09-28T12:00:00.000Z`

```json
{
  "period": {
    "type": "month",
    "time_zone": "Europe/Moscow",
    "start_date": "2026-09-01",
    "end_date": "2026-09-30",
    "from": "2026-08-31T21:00:00.000Z",
    "to": "2026-09-30T20:59:59.999Z",
    "as_of": "2026-09-28T12:00:00.000Z",
    "actual_to": "2026-09-28T12:00:00.000Z",
    "state": "current"
  },
  "currency": "EUR",
  "income": { "amount": "3000.00", "count": 1 },
  "expense": { "amount": "810.50", "count": 9 },
  "net": "2189.50",
  "transactions_count": 10,
  "previous": {
    "start_date": "2026-08-01",
    "end_date": "2026-08-31",
    "from": "2026-07-31T21:00:00.000Z",
    "to": "2026-08-31T20:59:59.999Z",
    "actual_to": "2026-08-28T12:00:00.000Z",
    "income": { "amount": "3000.00", "count": 1 },
    "expense": { "amount": "300.00", "count": 2 },
    "net": "2700.00",
    "transactions_count": 3
  },
  "change": {
    "income": { "delta": "0.00", "percent": 0 },
    "expense": { "delta": "510.50", "percent": 170.2 },
    "net": { "delta": "-510.50", "percent": -18.9 }
  },
  "last_transaction_date": "2026-09-28"
}
```

S0 (starting balance) and F1 (after `as_of`) are excluded; S5/S6 (deleted
wallet, archived category) and S8 (zero amount) are included. A4 is after
the cut at August 28, 15:00 MSK. The latest transaction, S10, is on
September 28 in Moscow.

Trend: `granularity: "week"`, `totals` equal to the Summary figures.

| `key`      | `start_date` | `end_date` | `state`   | `income`  | `expense` |
| ---------- | ------------ | ---------- | --------- | --------- | --------- |
| `2026-W36` | 2026-09-01   | 2026-09-06 | `past`    | `3000.00` | `570.25`  |
| `2026-W37` | 2026-09-07   | 2026-09-13 | `past`    | `0.00`    | `140.00`  |
| `2026-W38` | 2026-09-14   | 2026-09-20 | `past`    | `0.00`    | `40.50`   |
| `2026-W39` | 2026-09-21   | 2026-09-27 | `past`    | `0.00`    | `49.75`   |
| `2026-W40` | 2026-09-28   | 2026-09-30 | `current` | `0.00`    | `10.00`   |

The first bucket:

```json
{
  "key": "2026-W36",
  "start_date": "2026-09-01",
  "end_date": "2026-09-06",
  "from": "2026-08-31T21:00:00.000Z",
  "to": "2026-09-06T20:59:59.999Z",
  "state": "past",
  "income": "3000.00",
  "expense": "570.25"
}
```

Breakdown: `total: { "amount": "810.50", "count": 9 }`. `by_category`
(`icon`/`color` omitted):

```json
{
  "total_amount": "810.50",
  "source_count": 6,
  "primary_items": [
    {
      "kind": "category",
      "key": "category:10",
      "id": 10,
      "name": "Groceries",
      "amount": "500.00",
      "percent": 61.7,
      "is_archived": false,
      "opens_history": true
    },
    {
      "kind": "category",
      "key": "category:11",
      "id": 11,
      "name": "Restaurants",
      "amount": "120.00",
      "percent": 14.8,
      "is_archived": false,
      "opens_history": true
    },
    {
      "kind": "category",
      "key": "category:14",
      "id": 14,
      "name": "Gifts",
      "amount": "80.00",
      "percent": 9.9,
      "is_archived": true,
      "opens_history": true
    },
    {
      "kind": "category",
      "key": "category:12",
      "id": 12,
      "name": "Transport",
      "amount": "70.00",
      "percent": 8.6,
      "is_archived": false,
      "opens_history": true
    },
    {
      "kind": "category",
      "key": "category:13",
      "id": 13,
      "name": "Health",
      "amount": "25.50",
      "percent": 3.1,
      "is_archived": false,
      "opens_history": true
    }
  ],
  "other": {
    "kind": "other",
    "key": "other",
    "id": null,
    "name": null,
    "icon": null,
    "color": null,
    "amount": "15.00",
    "percent": 1.9,
    "is_archived": false,
    "opens_history": false,
    "children": [
      {
        "kind": "category",
        "key": "category:15",
        "id": 15,
        "name": "Pets",
        "amount": "15.00",
        "percent": 1.9,
        "is_archived": false,
        "opens_history": true
      }
    ]
  }
}
```

Health (25.50 of 810.50, 3.15%) passes the 3% threshold; Pets (1.85%) is
folded although a primary slot is free. Fees (S8) has a zero sum and is
left out, so `source_count` is 6, not 7.

`by_wallet`:

| Part              | Item   | `amount` | `percent` |
| ----------------- | ------ | -------- | --------- |
| `primary_items`   | 1 Card | `560.00` | 69.1      |
| `primary_items`   | 2 Cash | `145.00` | 17.9      |
| `deleted_wallets` | —      | `105.50` | 13        |

`source_count: 3` (Card, Cash, Old card); `deleted_wallets.wallets_count:
1`; `other: null`. Savings (4) has no expenses and is absent.

### Example 2 — current week, zone boundary, zero comparison

`period=week&time_zone=Europe/Moscow`: week 2026-09-28 … 2026-10-04,
`from: "2026-09-27T21:00:00.000Z"`. S10 (`2026-09-27T21:30Z`) belongs to
this week in Moscow; with `time_zone=UTC` it belongs to the previous week.

- `income: { "amount": "0.00", "count": 0 }`, `expense: { "amount": "10.00", "count": 1 }`, `net: "-10.00"`.
- Previous: week 2026-09-21 … 2026-09-27, cut at `2026-09-21T12:00:00.000Z`
  (Monday 15:00 MSK): only S8, `expense: { "amount": "0.00", "count": 1 }`.
- `change.expense: { "delta": "10.00", "percent": null }`: the base is zero
  though the previous period is not empty.
- Trend: 7 `day` buckets; Tuesday to Sunday are `future` with `null` values.

### Example 3 — past custom range

`period=custom&from_date=2026-09-10&to_date=2026-09-20&time_zone=Europe/Moscow`:
11 days, `state: "past"`, `actual_to = to = "2026-09-20T20:59:59.999Z"`.

- `income: { "amount": "0.00", "count": 0 }`, `expense: { "amount": "120.50", "count": 3 }` (S5, S6, S7), `net: "-120.50"`.
- `previous: null`, `change: null`.
- Trend: 11 `day` buckets, all `past`.

A custom 2026-07-01 … 2026-09-28 (90 days) is `current` and trends by
`week`: 14 buckets, the first 2026-07-01 … 2026-07-05, the last
2026-09-28 … 2026-09-28.

### Example 4 — year and a future month

- `period=year`: 2026-01-01 … 2026-12-31, `current`; previous 2025 cut at
  `2025-09-28T12:00:00.000Z`. Trend: 12 `month` buckets, October to
  December `future`.
- `period=month&anchor_date=2027-02-10`: `future`, all zeros, `previous`
  and `change` `null`; trend `week`, 4 buckets (February 2027 starts on a
  Monday), all `future` with `null` values.
- A custom 2026-12-15 … 2027-01-20 (37 days) trends by `week` across the new
  year: `2026-W51` from December 15, …, `2026-W53` (December 28 to January
  3), …, `2027-W03` to January 20. A year 2028 trends by 12 `month` buckets,
  `2028-02` being 29 days long.

### Example 5 — DST

`time_zone=Europe/Berlin&period=week&anchor_date=2026-10-25`: week
2026-10-19 … 2026-10-25, `from: "2026-10-18T22:00:00.000Z"` (CEST, UTC+2),
`to: "2026-10-25T22:59:59.999Z"` (CET, UTC+1). The October 25 bucket is 25
hours long: `from: "2026-10-24T22:00:00.000Z"`,
`to: "2026-10-25T22:59:59.999Z"`.

Comparing across a DST change keeps the local wall-clock time: `as_of =
2026-10-26T11:00:00.000Z` (Monday 12:00 CET) cuts the previous week at
`2026-10-19T10:00:00.000Z` (Monday 12:00 CEST), not at the same UTC instant.

In `America/Santiago` midnight of 2026-09-06 does not exist (clocks jump to
01:00): that day starts at `2026-09-06T04:00:00.000Z` and is 23 hours long.

## Out of scope

- Income breakdown, cross-space or multi-currency statistics.
- Planned or recurring transactions: the model has none; a transaction
  dated after `as_of` is simply not counted yet.
- A database snapshot shared by the three blocks, and caching.
