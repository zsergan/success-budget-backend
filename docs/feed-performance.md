# Transactions feed performance

How `GET /spaces/:spaceId/transactions/feed` (see
[`transactions-contract.md`](transactions-contract.md#get-spacesspaceidtransactionsfeed))
behaves on a large history: the measurements, the query plans behind them,
and why the feed reads the way it does and uses the index it does.

## Setup

- MySQL 8.4.11 in Docker (`docker-compose.yml`, default settings,
  `innodb_buffer_pool_size` 128 MB), on an Apple M1 Pro.
- `transactions` holds **500,000 rows**: **120,000 in the measured space**
  and 380,000 in another space, so that a plan that reads other spaces' rows
  shows up in the timings.
- The measured space: 4 wallets with transactions (one of them
  soft-deleted) and one empty wallet; the default categories; records spread
  over 2023-01-01 to 2026-09-30 (about 2,700 a month, 29,000 a year), 10 %
  income, 15 % without a description. On top of that, 5,000 records on one
  day (2026-06-15) and 2,000 records at one instant (2026-05-01T12:00:00Z).
  About 15 % of the descriptions contain "coffee".
- Each figure is the median of 7 runs of `TransactionsService.getFeed()`
  after a warm-up run: the whole response with its access check, snapshot
  transaction, page, `summary` and `day_totals`, without HTTP and JSON.

Reproduce with `npm run bench:feed -- --noise 380000` (on a disposable
database; it refuses to run with `NODE_ENV=production`). It prints the
timings and the `EXPLAIN ANALYZE` of every query it ran, and removes its
data unless `--keep` is given.

## Results

Response time, ms. **Before**: the feed as first implemented, with the
index `(wallet_id, timestamp)`. **Queries**: the reworked queries (below),
same index. **Queries + index**: the reworked queries with the index
`(wallet_id, timestamp, id, category_id, transaction_type, amount)`.

| Scenario                                  | Selection | Before | Queries | Queries + index |
| ----------------------------------------- | --------: | -----: | ------: | --------------: |
| Month, first page                         |     2,712 |    297 |      21 |             9.6 |
| Year, first page                          |    29,093 |    447 |      87 |              27 |
| All history, home (`limit=5`)             |   120,000 |    908 |     274 |              67 |
| All history, page 100,000 records deep    |   120,000 |  1,227 |     281 |              73 |
| Month, search "coffee" (frequent)         |       432 |    361 |      23 |              25 |
| Year, search "coffee"                     |     4,597 |    593 |      82 |              98 |
| All history, search "coffee"              |    17,821 |  1,125 |     277 |             279 |
| Year, search with no match                |         0 |    321 |     136 |             69¹ |
| All history, search with no match         |         0 |    739 |     525 |            266¹ |
| Inside 2,000 records of one instant       |     4,772 |    467 |      30 |              12 |
| All history, around a 2023 record         |   120,000 |  1,327 |     287 |              76 |
| Month of a 2023 record, around it         |     2,972 |    539 |      22 |              15 |
| One day with 5,000 records, first page    |     5,000 |    302 |      38 |              22 |
| One day with 5,000 records, around middle |     5,000 |    467 |      45 |              29 |

¹ Also with the empty-page shortcut (see [Aggregates](#aggregates)).

The page query and the summary query alone, ms:

| Selection                    | Page before | Page after | Summary before | Summary after |
| ---------------------------- | ----------: | ---------: | -------------: | ------------: |
| Month                        |         163 |        3.0 |             23 |           2.3 |
| Year                         |         222 |        7.1 |             76 |            16 |
| All history                  |         389 |        4.8 |            246 |            57 |
| All history, search "coffee" |         392 |         11 |            260 |           265 |

## Findings

### The space was a join, and MySQL scanned every space

Every query selected the space as `wallet.space_id = ?` through the join to
`wallets`. For the page (`ORDER BY timestamp DESC, id DESC LIMIT 51`) and for
the day totals (`timestamp BETWEEN … OR …`) the optimizer started from
`transactions` instead: **a full scan of the table, all 500,000 rows of
every space**, a filter on the period, then a sort, and only then the join
that drops the other spaces. Their cost grew with the whole table, not with
the space or the page. The summary happened to start from `wallets`, but
read all of each wallet's index entries (`ref` with an index condition)
rather than the period's range.

Now the space's wallet ids (soft-deleted included) are read first, in the
same snapshot, and every query takes `transaction.wallet_id IN (…)`: with
constants, MySQL plans an index range per wallet over the period, for any
size of the table. The joins stay, for the search and the system category.
The wallet filter narrows the list to its one id.

### Pages: one branch per wallet

Records of several wallets cannot be read in `(timestamp, id)` order from
an index whose first column is the wallet: MySQL read the whole period of
every wallet and sorted it (120,000 rows for "all history", whatever the
page size). The page is now a `UNION ALL` of one branch per wallet, each
`wallet_id = <constant>` with the keyset condition, `ORDER BY timestamp,
id` and `LIMIT limit + 1`. Each branch is a reverse index range scan that
stops after `limit + 1` entries; only `wallets × (limit + 1)` ids are sorted
together, and the page's rows are then loaded by primary key. The cost no
longer depends on the period, the depth of the page or the size of the
history: 3 to 11 ms for every scenario above. There is no `OFFSET` anywhere.

The keyset condition is written as
`timestamp <= :t AND (timestamp < :t OR id < :id)` (mirrored for newer
records), which is the same set as `(timestamp, id) < (:t, :id)` but lets
MySQL start the range at `:t`.

A space with a great many wallets (soft-deleted ones count) gets as many
branches; with the wallet counts the app has, that is a handful. Revisit if
spaces with hundreds of wallets appear.

### Ties and milliseconds

2,000 records at one instant are ordered by `id` straight from the index:
the index carries `id` after `timestamp`. `timestamp` keeps its
milliseconds (`TIMESTAMP(3)`), so records 1 ms apart are distinct positions;
the e2e tests page through both cases with pages of 1.

### Opening around a record

The record's position is a primary-key lookup; the window reads at most
`limit` rows on each side with the same branches, never the rows between the
period start and the record. The page part takes a few milliseconds in a
period of 120,000 records; the rest of the response is its totals.

### Aggregates

Paging limits the rows sent, not the rows counted: `summary` and the day
totals read the whole selection, in MySQL (`COUNT`/`SUM`, nothing is loaded
into Node.js). Their cost grows linearly with the selection: 2 ms for a
month, 16 ms for a year, 57 ms for 120,000 records with the new index. That
is what dominates a response over a long period (home, deep pages, around a
record). The day totals only read the page's days, one index range per day
and wallet: under 1 ms for an ordinary page, a few ms when a day holds
thousands of records.

With the old index each summed row was also looked up in the clustered
index for `amount`, `transaction_type` and `category_id`: 246 ms for 120,000
rows. The new index carries those columns, so the summary reads the index
only (4.3× faster for all history, 4.7× for a year).

An empty first page means an empty selection, so its totals are known
without counting: the feed skips the summary then. This halves a search
with no match, which otherwise scanned the period twice.

### Search

A search reads `description`, the category name and the wallet name of
every record of the period: no index can serve a substring match, and the
description is not in any index. Its cost is about 2 µs per record of the
period: 25 ms for a month, about 100 ms for a year, about 270 ms for 120,000
records. The number of matches hardly matters; a search with no match costs
the same as one with many, and the empty-page shortcut avoids paying it
twice.

It is not replaced by a FULLTEXT index (`MATCH … AGAINST`): that matches
whole words or prefixes with a stopword list and a minimum token size, not
substrings ignoring case and accents, so results would change. A separate
search service is not warranted at these figures: the app searches within
a chosen period, normally a month.

## Index

Migration `1790500000000-ExtendTransactionWalletTimestampIndex` replaces
`IDX_transactions_wallet_id_timestamp (wallet_id, timestamp)` with
`IDX_transactions_wallet_id_timestamp_id (wallet_id, timestamp, id,
category_id, transaction_type, amount)`.

- **`id` third.** InnoDB appends the primary key to a secondary index after
  its own columns. With `(wallet_id, timestamp)` that gave the
  `(timestamp, id)` order for free; with more columns after `timestamp` it
  would not, and every page branch would sort. Spelled out, `id` keeps that
  order and is not stored twice.
- **`category_id`, `transaction_type`, `amount`.** What the summary and the
  day totals read: with them these aggregates are index-only. The category join for `is_system` is a primary-key lookup in
  the small `categories` table.
- **Replace, not add.** Its prefix is the old index, so every query that
  used the old one (history, count, statistics, wallet totals, limits) uses
  this one the same way; keeping both would only cost writes. It also
  serves the wallet foreign key.
- **Cost.** 29.6 MB → 34.6 MB for 500,000 rows (about 10 bytes a row).
  Inserts and deletes update one index, as before; an edit of the amount,
  type or category now also updates its entry.
- **Deployment.** Both steps are online (`ALGORITHM=INPLACE, LOCK=NONE`):
  the new index is built while writes continue, then the old one is dropped,
  so the foreign key is never without an index. About 3 s for 500,000 rows
  here; `down()` restores the old index the same way. Each step commits on
  its own, so both directions check the indexes first: run again after
  being stopped at any point, they finish the remaining steps. If the index a direction creates already
  exists with another definition, it stops without changing anything. The previous build
  runs on the new schema unchanged, so a rollback of the application needs
  no schema rollback. `REQUIRED_MIGRATION` names this migration.

No index on `description` or the names: a B-tree index cannot serve
`LIKE '%…%'`, see [Search](#search).
