# Statistics API contract

Contract for the mobile Stats tab: three independently loadable blocks
(Summary, Trend, Breakdown) for one space, plus history filters that let a
user re-check every number in the transaction list. This document is the
source of truth for the backend implementation and the mobile integration;
the rules below apply to all three endpoints identically.

Status: **draft, stage 1** — endpoints are not implemented yet. Anything
marked _open_ needs sign-off before the stage that implements it.

## Endpoints

All routes are under `/api/v1`, require the bearer token and membership in
the space (a non-member gets the usual `403 FORBIDDEN_SPACE`).

| Method | Route                                 | Block                                         |
| ------ | ------------------------------------- | --------------------------------------------- |
| `GET`  | `/spaces/:spaceId/stats/summary`      | Income, Expense, Net, previous-period compare |
| `GET`  | `/spaces/:spaceId/stats/trend`        | Income/Expense/Net per bucket                 |
| `GET`  | `/spaces/:spaceId/stats/breakdown`    | Expense split by category or wallet, Other    |
| `GET`  | `/spaces/:spaceId/transactions` (ext) | History, new `category_id`/`wallet_id` filter |

Each block is a separate request with the same period parameters, so the
screen can load, fail and retry them independently. Every response echoes the
resolved `period`, so blocks loaded at different moments can be checked for
consistency by the client.

## Calculation rules

1. **One space.** Statistics cover the selected space only: every wallet
   of the space, including soft-deleted ones. There is no cross-space total.
2. **Space currency.** All amounts are in `Space.currency` and returned as
   `currency` (the currency code). There is no FX conversion; wallets and
   transactions have no currency of their own.
3. **Income excludes starting balances.** A transaction on the system
   category (`Category.is_system = 1`, "Initial balance") is excluded from
   every statistic: income, counts, trend, breakdown, `has_any_transactions`.
   The exclusion is by the system category, not by name or amount.
4. **Type comes from the transaction.** A transaction counts as income or
   expense by `Transaction.transaction_type`, never by its category's type.
5. **Net = Income − Expense.** Income and expense are non-negative sums;
   net is signed.
6. **History is kept.** Transactions on archived categories and on
   soft-deleted wallets are counted everywhere. Archived categories keep
   their own row in the breakdown (`is_archived: true`); deleted wallets are
   merged into one `deleted_wallets` group (see Breakdown).
7. **No future transactions.** A transaction with `timestamp` after the
   request's `now` is not part of any actual sum or count, even inside the
   selected period. The period's actual range ends at `min(period end, now)`.
8. **Zero is not empty.** `"0.00"` does not mean there were no
   transactions: zero-amount transactions are valid, and income may equal
   expense. Every sum is paired with a `count`; "no data" states are decided
   by counts, never by amounts.
9. **Exact money.** Sums are computed in integer cents (`SUM` strings parsed
   with `parseMoney`, arithmetic on `bigint`, `formatMoney` for output) as in
   `src/shared/utils/money.ts`. No amount is ever a JS `number` on the way.
10. **One `now` per request.** `now` is read once per request and used for
    the period, the actual range, the comparison window and bucket states.

## Common query parameters

| Param    | Type                                    | Required              | Meaning                                                           |
| -------- | --------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `period` | `week` \| `month` \| `year` \| `custom` | yes                   | Period kind                                                       |
| `tz`     | IANA zone (`Europe/Moscow`)             | yes                   | Zone that defines days, weeks, months and years; `UTC` is valid   |
| `date`   | `YYYY-MM-DD`                            | no, not with `custom` | Any day inside the wanted week/month/year; default: today in `tz` |
| `from`   | `YYYY-MM-DD`                            | with `custom` only    | First local day, inclusive                                        |
| `to`     | `YYYY-MM-DD`                            | with `custom` only    | Last local day, inclusive                                         |

Validation (400, standard `message: [{ field, error }]` shape):

- `period` missing or not one of the four values;
- `tz` missing or not a zone known to the runtime's `Intl` (offsets like
  `+03:00` are rejected — they break on DST);
- `date`/`from`/`to` not a strict `YYYY-MM-DD` calendar date, empty or
  repeated;
- `from`/`to` missing with `custom`, or present with another period; `date`
  present with `custom`;
- `from` after `to`; a custom range longer than **366 days** (_open_: cap);
- a period that reaches outside the MySQL `TIMESTAMP` range (1970–2037).

A period entirely in the future is valid: it resolves with
`state: "future"` and zero sums.

## Periods

All boundaries are computed in `tz`, then converted to instants.

| `period` | Local range                                                    |
| -------- | -------------------------------------------------------------- |
| `week`   | Monday through Sunday (ISO 8601 week) containing `date`        |
| `month`  | First through last day of the calendar month containing `date` |
| `year`   | January 1 through December 31 of the year containing `date`    |
| `custom` | `from` through `to`                                            |

A local day starts at its first existing instant in `tz` (midnight, or the
first instant after a DST gap) and ends right before the next day starts.
Days are therefore 23, 24 or 25 hours long; the range is never computed as
"start + N × 24h".

```ts
interface StatsPeriod {
  type: 'week' | 'month' | 'year' | 'custom';
  tz: string;
  start_date: string; // local, YYYY-MM-DD, inclusive
  end_date: string; // local, YYYY-MM-DD, inclusive
  from: string; // ISO instant (UTC, ms) of start_date's first moment
  to: string; // ISO instant of end_date's last millisecond
  actual_to: string | null; // min(to, now); null when state = 'future'
  state: 'past' | 'current' | 'future';
}
```

- `past`: `to < now`; `actual_to = to`.
- `current`: `from <= now <= to`; `actual_to = now`.
- `future`: `from > now`; `actual_to = null`, every sum is `"0.00"` and
  every count `0`.

Transactions are selected with `from <= timestamp <= actual_to`, inclusive
on both ends like the existing history filter, so `from`/`actual_to` can be
passed to `GET /transactions` unchanged.

### Previous period (comparison)

| `period`              | Previous period                               |
| --------------------- | --------------------------------------------- |
| `week`/`month`/`year` | The preceding calendar week/month/year        |
| `custom` (N days)     | The N days ending the day before `start_date` |

When the selected period is `current`, the comparison is like-for-like: the
previous period is cut at the **same position** at the **same local wall
clock time** as `now`, so a month in progress is not compared to a whole
month.

| `period` | Same position                                                         |
| -------- | --------------------------------------------------------------------- |
| `week`   | Same weekday                                                          |
| `month`  | Same day of month, clamped to the previous month's last day (31 → 30) |
| `year`   | Same month and day, Feb 29 → Feb 28                                   |
| `custom` | Same day offset from the start                                        |

The cut instant is clamped to the previous period's `to`. When the selected
period is `past` or `future`, the whole previous period is used, still
limited to `now` by rule 7 (the previous period of a future month may be the
current one).

## Money and percentages

- Money is a decimal **string** with exactly two decimals, `-` for negatives
  only: `"1234.50"`, `"0.00"`, `"-510.50"`. No thousands separator, no
  currency sign. (Older endpoints return numbers; the new API does not.)
- Sums may exceed the per-amount input range `99999999.99`.
- Percentages are JSON **numbers** with one decimal, computed from cents by
  `roundPercentToTenth` (halves toward +∞).

| Field                   | Formula                                     | When the base is zero |
| ----------------------- | ------------------------------------------- | --------------------- |
| `change.*.delta`        | `current − previous` (money string, signed) | —                     |
| `change.*.percent`      | `(current − previous) / \|previous\| × 100` | `null`                |
| `items[].share_percent` | `amount / total × 100`                      | `0`                   |

`percent` uses `|previous|` so a rise of a negative net is still positive.
Shares are rounded one by one and may not add up to exactly `100.0`.

## Summary

`GET /spaces/:spaceId/stats/summary?period=&tz=[&date=|&from=&to=]`

```ts
interface MoneyCount {
  amount: string;
  count: number;
}

interface Change {
  delta: string;
  percent: number | null;
}

interface StatsSummary {
  period: StatsPeriod;
  currency: string;
  income: MoneyCount;
  expense: MoneyCount;
  net: string;
  transactions_count: number; // income.count + expense.count
  previous: {
    start_date: string;
    end_date: string;
    from: string;
    to: string; // the cut instant, inclusive
    income: MoneyCount;
    expense: MoneyCount;
    net: string;
    transactions_count: number;
  };
  change: {
    income: Change;
    expense: Change;
    net: Change;
  };
  // any non-system transaction in the space up to now, in any period
  has_any_transactions: boolean;
}
```

Screen states come from counts: `has_any_transactions = false` → first-run
empty state; `transactions_count = 0` → "no transactions in this period";
otherwise data (even when every amount is `"0.00"`).
`previous.transactions_count = 0` → no comparison to show.

## Trend

`GET /spaces/:spaceId/stats/trend?period=&tz=[&date=|&from=&to=]`

| `period`            | Granularity | Buckets                                    |
| ------------------- | ----------- | ------------------------------------------ |
| `week`              | `day`       | 7                                          |
| `month`             | `day`       | 28–31                                      |
| `year`              | `month`     | 12                                         |
| `custom` ≤ 31 days  | `day`       | one per day                                |
| `custom` ≤ 182 days | `week`      | ISO weeks, first/last clipped to the range |
| `custom` > 182 days | `month`     | calendar months, first/last clipped        |

```ts
interface TrendBucket {
  start_date: string;
  end_date: string;
  from: string;
  to: string;
  state: 'past' | 'current' | 'future';
  income: string | null; // null only when state = 'future'
  expense: string | null;
  net: string | null;
  count: number;
}

interface StatsTrend {
  period: StatsPeriod;
  currency: string;
  granularity: 'day' | 'week' | 'month';
  buckets: TrendBucket[]; // chronological, covering the whole period
}
```

Buckets always cover the whole period so the chart axis is stable. A
`future` bucket has `null` amounts (not drawn), a `current` one covers
`from..now`. Bucket sums add up exactly to the Summary of the same request
parameters.

## Breakdown

`GET /spaces/:spaceId/stats/breakdown?period=&tz=&group_by=category|wallet[&date=|&from=&to=]`

Expenses only. `group_by` is required (400 otherwise).

```ts
interface BreakdownBase {
  amount: string;
  count: number;
  share_percent: number;
}

interface CategoryItem extends BreakdownBase {
  kind: 'category';
  category: { id: number; name: string; icon: CategoryIcon; color: AppColor; is_archived: boolean };
}

interface WalletItem extends BreakdownBase {
  kind: 'wallet';
  wallet: { id: number; wallet_name: string; design: AppColor };
}

interface OtherItem extends BreakdownBase {
  kind: 'other';
  items: (CategoryItem | WalletItem)[]; // members, same order rules
}

interface DeletedWalletsItem extends BreakdownBase {
  kind: 'deleted_wallets';
  wallets_count: number;
}

interface StatsBreakdown {
  period: StatsPeriod;
  currency: string;
  group_by: 'category' | 'wallet';
  total: MoneyCount; // equals Summary expense
  items: (CategoryItem | WalletItem | OtherItem | DeletedWalletsItem)[];
}
```

- A group appears only if it has at least one expense in the actual range
  (`count > 0`); its amount may be `"0.00"`.
- Item order: regular items by `amount` desc, ties by name (case-insensitive)
  then `id` asc; then `other`; then `deleted_wallets`.
- `category`/`wallet` items are clickable (history filter). `other` is an
  expandable aggregate, not a category or wallet in the database, and has no
  id. `deleted_wallets` is **not clickable** and never expands; it merges all
  soft-deleted wallets of the space.
- Category names/icons/colors are the current values, archived included.

### Other

Applied to regular items only (never to `deleted_wallets`), after sorting,
with exact cent comparisons (`amount × 100 < total × 5`, no rounded shares):

1. Keep the first **5** items visible. _(open: constant)_
2. Of those, an item whose amount is below **5 %** of `total` moves to
   Other. _(open: constant)_
3. Every item after the fifth moves to Other.
4. If Other ends up with exactly one item, that item stays visible and there
   is no Other.
5. `other.amount`/`count` are the sums of its members; members keep their
   own `share_percent` of the full total.

> _Open:_ the product plan refers to an Other algorithm that was not part of
> the stage 1 brief. The rules above are the backend's proposal and must be
> replaced verbatim if the plan defines them differently.

## History filters (drill-down)

`GET /spaces/:spaceId/transactions` gains two optional, mutually exclusive
query parameters:

| Param         | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `category_id` | Only transactions of this category (archived allowed, system rejected) |
| `wallet_id`   | Only transactions of this wallet (active wallets only)                 |

A foreign, missing or system category, and a foreign, missing or deleted
wallet, is the existing `403` of that resource; both parameters at once is a 400. To reproduce a breakdown item, the client calls:

```
GET /spaces/:spaceId/transactions?from={period.from}&to={period.actual_to}&category_id={id}
```

`from`/`to` are exact instants, so the history uses the same bounds as the
statistics regardless of the server's zone. The history list still contains
starting-balance transactions for a wallet filter; they have
`transaction_type: "income"` and do not affect the expense breakdown.

## Worked examples

Fixed test clock: **now = `2026-09-28T12:00:00.000Z`** (Monday, 15:00 in
`Europe/Moscow`, UTC+3 without DST). The data set, amounts and names are
test fixtures only; nothing here (a 30-day month, 5 visible categories in a
design mock, a specific currency) is an application constant.

Space currency `EUR`. Wallets: `1` Card, `2` Cash, `4` Savings (active), `3`
Old card (deleted). Categories: `10` Groceries, `11` Restaurants, `12`
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
| F1  | 2026-09-29 10:00 | expense | Groceries       | 1      | 500.00  | future: excluded                   |

### Example 1 — current month

`GET /stats/summary?period=month&tz=Europe/Moscow` (`date` defaults to
2026-09-28):

```json
{
  "period": {
    "type": "month",
    "tz": "Europe/Moscow",
    "start_date": "2026-09-01",
    "end_date": "2026-09-30",
    "from": "2026-08-31T21:00:00.000Z",
    "to": "2026-09-30T20:59:59.999Z",
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
    "to": "2026-08-28T12:00:00.000Z",
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
  "has_any_transactions": true
}
```

S0 (starting balance) and F1 (future) are excluded; S5/S6 (deleted wallet,
archived category) and S8 (zero amount) are included. A4 is after the cut
at Aug 28 15:00 MSK.

Trend for the same parameters: `granularity: "day"`, 30 buckets. Selected
buckets:

| `start_date` | `state`   | `income`  | `expense` | `net`     | `count` |
| ------------ | --------- | --------- | --------- | --------- | ------- |
| 2026-09-01   | `past`    | `3000.00` | `0.00`    | `3000.00` | 1       |
| 2026-09-21   | `past`    | `0.00`    | `0.00`    | `0.00`    | 1       |
| 2026-09-27   | `past`    | `0.00`    | `49.75`   | `-49.75`  | 1       |
| 2026-09-28   | `current` | `0.00`    | `10.00`   | `-10.00`  | 1       |
| 2026-09-29   | `future`  | `null`    | `null`    | `null`    | 0       |

Breakdown `group_by=category` (total `810.50`, 9):

```json
[
  {
    "kind": "category",
    "category": { "id": 10, "name": "Groceries", "is_archived": false },
    "amount": "500.00",
    "count": 2,
    "share_percent": 61.7
  },
  {
    "kind": "category",
    "category": { "id": 11, "name": "Restaurants", "is_archived": false },
    "amount": "120.00",
    "count": 1,
    "share_percent": 14.8
  },
  {
    "kind": "category",
    "category": { "id": 14, "name": "Gifts", "is_archived": true },
    "amount": "80.00",
    "count": 1,
    "share_percent": 9.9
  },
  {
    "kind": "category",
    "category": { "id": 12, "name": "Transport", "is_archived": false },
    "amount": "70.00",
    "count": 2,
    "share_percent": 8.6
  },
  {
    "kind": "other",
    "amount": "40.50",
    "count": 3,
    "share_percent": 5,
    "items": [
      {
        "kind": "category",
        "category": { "id": 13, "name": "Health", "is_archived": false },
        "amount": "25.50",
        "count": 1,
        "share_percent": 3.1
      },
      {
        "kind": "category",
        "category": { "id": 15, "name": "Pets", "is_archived": false },
        "amount": "15.00",
        "count": 1,
        "share_percent": 1.9
      },
      {
        "kind": "category",
        "category": { "id": 16, "name": "Fees", "is_archived": false },
        "amount": "0.00",
        "count": 1,
        "share_percent": 0
      }
    ]
  }
]
```

(`icon`/`color` omitted for brevity.) Health, Pets and Fees are each under
5 % of the total, so they form Other. Other's own share (`40.50 / 810.50` =
4.997 %) rounds to `5` but is not re-checked against the threshold.

Breakdown `group_by=wallet` (total `810.50`, 9):

| `kind`            | Wallet | `amount` | `count` | `share_percent` |
| ----------------- | ------ | -------- | ------- | --------------- |
| `wallet`          | 1 Card | `560.00` | 4       | 69.1            |
| `wallet`          | 2 Cash | `145.00` | 3       | 17.9            |
| `deleted_wallets` | —      | `105.50` | 2       | 13              |

Savings (4) has no expenses and is absent; `deleted_wallets` has
`wallets_count: 1`.

### Example 2 — current week, zone boundary, zero comparison

`GET /stats/summary?period=week&tz=Europe/Moscow`: week 2026-09-28 …
2026-10-04, `from: "2026-09-27T21:00:00.000Z"`. S10 (`2026-09-27T21:30Z`)
belongs to this week in Moscow; with `tz=UTC` it would belong to the
previous week.

- `expense: { "amount": "10.00", "count": 1 }`, `income: { "amount": "0.00", "count": 0 }`, `net: "-10.00"`.
- Previous: week 2026-09-21 …, cut at `2026-09-21T12:00:00.000Z` (Monday
  15:00 MSK): only S8, so `expense: { "amount": "0.00", "count": 1 }`.
- `change.expense: { "delta": "10.00", "percent": null }` — base is zero,
  though the previous period is not empty (`transactions_count: 1`).

### Example 3 — past custom range

`GET /stats/summary?period=custom&from=2026-09-10&to=2026-09-20&tz=Europe/Moscow`:
11 days, `state: "past"`, `actual_to = to = "2026-09-20T20:59:59.999Z"`.
Previous: 2026-08-30 … 2026-09-09 (11 days, whole).

|         | Current (S5, S6, S7) | Previous (S1–S4; S0 excluded) | `delta`    | `percent` |
| ------- | -------------------- | ----------------------------- | ---------- | --------- |
| income  | `0.00` / 0           | `3000.00` / 1                 | `-3000.00` | -100      |
| expense | `120.50` / 3         | `630.25` / 3                  | `-509.75`  | -80.9     |
| net     | `-120.50`            | `2369.75`                     | `-2490.25` | -105.1    |

Trend: `granularity: "day"`, 11 buckets, all `past`.

### Example 4 — DST day

`tz=Europe/Berlin`, `period=week&date=2026-10-25`: week 2026-10-19 …
2026-10-25, `from: "2026-10-18T22:00:00.000Z"` (CEST, UTC+2),
`to: "2026-10-25T22:59:59.999Z"` (CET, UTC+1). The Oct 25 trend bucket is 25
hours long: `from: "2026-10-24T22:00:00.000Z"`, `to:
"2026-10-25T22:59:59.999Z"`. With the fixed `now` the week is `future`.

## Out of scope

- Income breakdown, cross-space or multi-currency statistics.
- Planned/recurring transactions: the model has none; a future-dated
  transaction is simply excluded until its time comes.
- Caching: every request is computed from the transaction table.
