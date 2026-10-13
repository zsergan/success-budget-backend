# Transactions API contract

Contract for creating, reading, editing and deleting transactions of one
space: the domain rules, the requests and responses, compatibility with
records written under the old rules, and machine-readable errors. It is the
source of truth for the backend implementation and the mobile integration.

Everything below is implemented unless the
[status table](#implementation-status) says otherwise. What the mobile client has to change, the
deployment order and what an older client still gets are collected under
[Migration and compatibility](#migration-and-compatibility); request and
response walkthroughs are under [Examples](#examples).

Out of scope: several currencies in one space, moving a transaction to
another space, transfers between wallets as one operation, and scheduled or
recurring transactions.

## Implementation status

| Part                                                                | Status      |
| ------------------------------------------------------------------- | ----------- |
| `code` on every error response                                      | implemented |
| Transaction view (`kind`, `version`, compact category) on all reads | implemented |
| `GET /transactions/:id`                                             | implemented |
| One locked DB transaction per write, `Idempotency-Key`              | implemented |
| Reworked `DELETE` with `If-Match`                                   | implemented |
| Stricter `POST`, description normalization on write                 | implemented |
| `PATCH /transactions/:id` with `If-Match`                           | implemented |
| Initial balance out of `GET /wallets` income                        | implemented |
| `GET /transactions/count`, stable history order                     | implemented |
| Limits month in the client's `time_zone`                            | implemented |
| `client_operation_id`, `GET /transactions/operations/:id`           | implemented |
| `GET /transactions/feed`: cursor pages, search, `around_id`         | implemented |
| `GET /transactions/feed`: `summary`, `day_totals`                   | implemented |
| Optional `q` on `GET /transactions/count`                           | implemented |

Code: `src/modules/transactions` (view in `transaction-view.ts`, OpenAPI
schemas in `dto/transaction-responses.ts`, the write unit in
`TransactionsService.write()`, operations in
`entities/transaction-operation.entity.ts`), `src/modules/idempotency`, error codes in
`src/shared/api.exception.ts` and `http-exception.filter.ts`. Tests:
`transaction-view.spec.ts`, `transactions.service.spec.ts`,
`idempotency.service.spec.ts`, `test/transactions.e2e-spec.ts`,
`test/transaction-writes.e2e-spec.ts` (repeats, concurrent writes and access revocation against
MySQL), `test/transaction-operations.e2e-spec.ts` (recovering a create after
the key expired), `test/transaction-lifecycle.e2e-spec.ts` (the full lifecycle with
every derived figure after each step, DST, and the OpenAPI document),
`test/api-contract.e2e-spec.ts` (`PATCH` as the edit, required versions,
the maximum amount on every money field, the monthly total limit) and the
response shapes in `test/type-contract.e2e-spec.ts`; the e2e
tests check the list, latest and details responses against their OpenAPI
schemas.

## Domain rules

1. **One wallet, one category, one space.** A regular transaction belongs to
   exactly one wallet and one category, both of the same space. Moving a
   transaction to another space is not supported: a wallet or category of
   another space is refused like a missing one.
2. **Type gives the direction.** `transaction_type` is `income` or
   `expense`. `amount` is a non-negative decimal string; its sign never
   carries the direction.
3. **Space currency.** Amounts are in the space's currency (`Space.currency`).
   Wallets and transactions have no currency of their own, so moving a
   transaction to another wallet changes neither its amount nor its currency.
4. **Amount.** A new or changed amount is greater than zero, at most
   `99999999.99`, with at most two decimal places. Invalid input is refused,
   never rounded or truncated.
5. **Description.** Optional, at most 140 characters. A missing description
   is always `null`: the server trims the input, and an empty result is
   stored and returned as `null`, never `""`.
6. **Timestamp.** A new or changed timestamp is not in the future (see
   [Timestamp](#timestamp)).
7. **Choosing a wallet and a category.** A new transaction takes an active
   (not deleted) wallet and an active (not archived), non-system category
   whose type equals `transaction_type`.
8. **Keeping the original links on edit.** An edit may keep the
   transaction's own wallet even if it was deleted since, and its own
   category even if it was archived since. It may not move the transaction
   to another deleted wallet or another archived category.
9. **Type and category agree.** When `transaction_type` or `category_id`
   changes, the resulting category's type must equal the resulting
   transaction type.
10. **Final state is checked.** An edit is validated as the record it
    produces (current values merged with the request), not field by field.
11. **Initial balance is a system record.** A wallet's starting balance is
    an `income` transaction on the space's system category ("Initial
    balance"), created only by `POST /wallets`. It can be read, but not
    edited or deleted through the transaction endpoints, and no regular
    transaction can be moved onto the system category.
12. **What counts where.** The initial balance is part of the wallet
    balance, but not of Income, Expense, Net, limits or a day's financial
    total (see [Effects on derived data](#effects-on-derived-data)).

## Endpoints

All routes are under `/api/v1` and require the bearer token and membership
in the target space. Transaction `wallet_id` and `category_id` are positive
integers within the signed MySQL `INT` range (1–2147483647); invalid values
return `400 VALIDATION_FAILED`. Limit `category_ids` follow the same range
and must not repeat.

Checks run in this order: request shape
(`400 VALIDATION_FAILED`, before anything is read), membership
(`403 FORBIDDEN_SPACE`), then the endpoint's own checks.

| Method   | Route                                          | Status   |
| -------- | ---------------------------------------------- | -------- |
| `POST`   | `/spaces/:spaceId/transactions`                | kept     |
| `GET`    | `/spaces/:spaceId/transactions`                | kept     |
| `GET`    | `/spaces/:spaceId/transactions/feed`           | new      |
| `GET`    | `/spaces/:spaceId/transactions/latest`         | kept     |
| `GET`    | `/spaces/:spaceId/transactions/count`          | new      |
| `GET`    | `/spaces/:spaceId/transactions/:transactionId` | new      |
| `PATCH`  | `/spaces/:spaceId/transactions/:transactionId` | new      |
| `DELETE` | `/spaces/:spaceId/transactions/:transactionId` | reworked |

`PATCH` is a partial update: an absent field keeps its current value. The
design's "PUT" label is not part of the contract; there is no `PUT`.

`:transactionId` is a UUID. A malformed id, an unknown id and the id of a
transaction of another space all give `404 TRANSACTION_NOT_FOUND`, so a
member cannot tell a foreign transaction from a missing one. A transaction
belongs to the space of its own wallet, soft-deleted wallets included.
`feed`, `latest` and `count` are reserved path segments, never ids. A non-numeric `:spaceId`
is `400 BAD_REQUEST`.

## Field rules

### Amount

| Rule   | Accepted                                                                  | Rejected (`400 VALIDATION_FAILED`, field `amount`)          |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Type   | decimal `string`                                                          | JSON number, `null`                                         |
| Format | digits, optionally `.` and one or two digits: `"12"`, `"12.3"`, `"12.30"` | sign (`"-1"`, `"+1"`), `".5"`, `"5."`, exponent, whitespace |
| Scale  | at most two decimal places                                                | `"1.234"`, `"1.230"`; never rounded or truncated            |
| Range  | `0.01` to `99999999.99` inclusive                                         | `"0"`, `"0.00"`, `"100000000"` and anything above           |

These are the existing money rules of
[`type-contract.md`](type-contract.md#money-rules) with zero excluded for
transactions. Limit amounts and wallet `initial_balance` keep accepting
zero.

### Description

- Optional on create; `null`, absent, `""` and whitespace-only all mean "no
  description" and are stored as `null`.
- Leading and trailing whitespace is trimmed; inner whitespace and line
  breaks are kept.
- At most **140 characters after trimming**, counted as Unicode code points
  (an emoji outside the BMP counts as one). Longer input is
  `400 VALIDATION_FAILED`, field `description`, never cut.
- Responses always carry `description: string | null`; a legacy `""` stored
  before this contract is returned as `null`.

### Timestamp

- An exact instant: an ISO 8601 date-time **with `Z` or a UTC offset**
  (`2026-09-15T10:00:00.000Z`, `2026-09-15T13:00:00+03:00`). A date-only
  or offset-less value is `400 VALIDATION_FAILED`: it used to be read in
  the server's time zone, which can put a transaction on another day than
  the device meant. The same rule applies to a `PATCH`; reads always return
  `Z` values, so echoing one back is fine.
- Within the MySQL `TIMESTAMP` range (1970-01-01T00:00:01Z to
  2038-01-19T03:14:07Z; see [`type-contract.md`](type-contract.md#dates)).
- Not in the future: an instant more than **60 seconds** after the server
  clock is `400 VALIDATION_FAILED`, field `timestamp`. The margin absorbs
  device clock drift, as `as_of` does in the statistics API.

## Compatibility with existing records

Records written under the old rules are never corrected or deleted
automatically. They may hold a zero amount, a future timestamp, a `""`
description, or a category whose type differs from the transaction type.

- **Unchanged values are not re-validated.** An edit that leaves a legacy
  value as it is succeeds; only new and changed values must follow the new
  rules. So a zero amount or a future timestamp survives an edit of the
  description, and a legacy type/category mismatch survives as long as
  neither `transaction_type` nor `category_id` changes.
- **Sending the current value is not a change.** A client that sends the
  whole form is treated like one that sends only the edited fields: a field
  equal to the stored value counts as unchanged. Equality is by value:
  `amount` in cents (`"0"` equals `"0.00"`), `timestamp` to the millisecond
  instant, ids by number, `description` after trimming and `""`→`null`.
  The same applies to `wallet_id` of a deleted wallet and `category_id` of
  an archived category: sending the transaction's own value keeps the link.
- Changing such a value means meeting the new rules: setting a zero amount
  to `"0.00"` again is a no-op, setting it to `"5.00"` is fine, setting a
  positive amount to `"0"` is refused.

## Responses

### Transaction view

One shape for every read: the list, the feed, `latest`, `GET /:id`, and the
`transaction` of a `PATCH` result. It is built field by field
(`toTransactionView`), so an entity column never reaches the client unless
it is listed here.

```ts
type TransactionKind = 'regular' | 'initial_balance';

interface TransactionWallet {
  id: number;
  wallet_name: string;
  design: AppColor;
  created_at: string;
  updated_at: string;
}

// Not the Categories API item: transaction_count, limit and sort are absent.
interface TransactionCategory {
  id: number;
  name: string;
  transaction_type: 'income' | 'expense';
  icon: CategoryIcon;
  color: AppColor;
  is_active: 0 | 1; // kept for compatibility; prefer is_archived
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

interface TransactionView {
  id: string; // UUID
  kind: TransactionKind;
  transaction_type: 'income' | 'expense';
  amount: string; // "12.30": always two decimals
  timestamp: string; // ISO-8601 UTC with milliseconds
  description: string | null; // never ""
  version: number; // starts at 1, bumped by every change of the record
  wallet: TransactionWallet | null; // null when the wallet is deleted
  category: TransactionCategory;
}
```

`kind` is the only supported way to recognize the initial balance. It comes
from the server's own data (the category's `is_system` flag, which stays
hidden), never from the category name, which is display text and can be
renamed. A client renders an `initial_balance` record read-only and offers
no edit or delete for it.

`wallet` is `null` for a deleted wallet in every read, as the list always
did. The edit screen therefore shows a deleted wallet without its name, and
keeps it by leaving `wallet_id` out of the `PATCH`.

`version` is the record's concurrency token: the client keeps the value it
read and sends it back as `If-Match: "<version>"` with an edit or a delete
(see [Retries and concurrency](#retries-and-concurrency)).

### `POST /spaces/:spaceId/transactions`

Request:

```ts
interface CreateTransactionRequest {
  wallet_id: number;
  category_id: number;
  transaction_type: 'income' | 'expense';
  amount: string;
  timestamp: string;
  description?: string | null;
  client_operation_id?: string; // UUID, one per user action
}
```

`201`, with the same three keys as before:

```ts
interface CreateTransactionResult {
  transaction: TransactionView; // the stored record, as GET /:id reads it
  wallet: TransactionWallet & { balance: number }; // balance after the transaction
  previous_balance: number; // balance before it
}
```

`transaction` is the [transaction view](#transaction-view), re-read after the
insert: every field it had before keeps its name and type, `kind`,
`wallet` and `category` are added, and `amount` has two decimals (`"12.30"`
for a request of `"12.3"`; it used to echo the request string).

`previous_balance` and `wallet.balance` are both sums of the wallet's
history, read in the same DB transaction under the wallet's lock, before
and after the insert. No other write to the wallet can land between them,
so `wallet.balance - previous_balance` is exactly the transaction's effect.

The server checks the wallet (of the space, not deleted), then the category
(of the space, not the system one, not archived, of the same type as
`transaction_type`).

Takes an optional `Idempotency-Key` header (see
[Idempotency-Key](#idempotency-key)) and an optional `client_operation_id`
(see [Recovering an unfinished create](#recovering-an-unfinished-create));
the mobile client sends both with every create, with the same UUID.

`client_operation_id` is unique in the space for as long as the space
exists, also after the transaction is deleted. A create with an id that was
already used is `409 TRANSACTION_OPERATION_EXISTS` and writes nothing,
whatever its body; it is checked before the wallet and the category, so a
create that already happened is reported as such even if its wallet was
deleted since. The id is compared case-insensitively.

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`IDEMPOTENCY_KEY_REUSED`, `TRANSACTION_OPERATION_EXISTS`, `FORBIDDEN_WALLET`,
`WALLET_DELETED`, `FORBIDDEN_CATEGORY`, `CATEGORY_ARCHIVED`,
`CATEGORY_TYPE_MISMATCH`.

### `GET /spaces/:spaceId/transactions`, `GET .../latest`

`TransactionView[]` and `TransactionView`, or an empty body when the space
has no transactions. Every pre-existing field keeps its name and type;
`kind`, `version` and `category.is_archived` are new, and a blank
description reads as `null`.

- **Order:** newest `timestamp` first; rows with the same timestamp by `id`,
  descending. The order is stable between requests, and `latest` is the
  first row of the unfiltered list.
- **Initial balance** records are listed, marked `kind: 'initial_balance'`.
  A wallet created with a starting balance therefore has a non-empty
  history even though its Income is zero; the client decides "no history"
  from the rows (or the count), never from an amount.
- **`kind` filter:** optional `kind=regular` leaves initial balances out,
  `kind=initial_balance` lists only them; without it both are listed. It
  is decided by the system category, never by name, and combines with the
  other filters. The statistics drill-down always sends `kind=regular`
  ([statistics contract](statistics-contract.md#opening-a-breakdown-item)).
- **Query:** `from` and `to` are inclusive instants (send them with `Z` or
  an offset: the device's day and month bounds; an offset-less value is
  read in server local time). Defaults are the server's current month.
  `from` after `to` is `400 VALIDATION_FAILED`, field `from`. The other
  parameters and their errors stay as in
  [`type-contract.md`](type-contract.md#absent-vs-null-vs-empty) and the
  [statistics contract](statistics-contract.md).

### `GET /spaces/:spaceId/transactions/count`

`200 { count: number }`: the number of rows `GET /transactions` returns for
the same query (`from`, `to`, `transaction_type`, `kind`, `category_id`,
`wallet_id`, same defaults and errors), initial balances included when they
fall into it and `kind` does not leave them out. It reads no rows, so the
calendar counter does not load the list. Errors as for the list.

Optional `q` counts the records matching that search, by the rules of the
feed's [Search](#search): trimmed, blank means no search, at most 255
characters (longer is `400 VALIDATION_FAILED`, field `q`, as is a repeated
`q`). With `q`, the count equals the feed's `summary.count` for the same
period, search and filters; without it, the counter counts every record of
the period as before. `GET /transactions` itself takes no `q`: an unknown
parameter is ignored there, as it always was.

### `GET /spaces/:spaceId/transactions/feed`

One paged read for every transaction list of the app: the history of a
period, search within it, the statistics drill-down (the same filters), the
latest records on the home screen and the history opened at one record.
Unlike `GET /transactions` it pages with a cursor and returns the totals of
the whole selection, computed by the server.

**Query:**

| Parameter          | Required | Rule                                                                                                                                          |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`       | yes      | Inclusive instants with `Z` or a UTC offset, no default; may be outside the stored range (below); `from` after `to` is an error               |
| `time_zone`        | yes      | IANA zone of the device (`Europe/Moscow`); groups the records into days. A fixed offset (`+03:00`) or an unknown zone is an error             |
| `q`                | no       | Search text, see [Search](#search). Trimmed at both ends, inner whitespace kept; empty after trimming means no search. At most 255 characters |
| `limit`            | no       | Page size, an integer `1`–`100`; default `50`                                                                                                 |
| `cursor`           | no       | `next_cursor` or `previous_cursor` of an earlier response to the same query                                                                   |
| `around_id`        | no       | Id of a transaction to open the history at; not with `cursor`                                                                                 |
| `transaction_type` | no       | `income` \| `expense`                                                                                                                         |
| `kind`             | no       | `regular` \| `initial_balance`                                                                                                                |
| `category_id`      | no       | A category of the space, archived allowed; the system one is refused                                                                          |
| `wallet_id`        | no       | An active wallet of the space                                                                                                                 |

The four filters are those of `GET /transactions`, with the same meaning
and errors. The **selection** is every transaction of the space with
`from <= timestamp <= to` that matches `q` and the filters; initial
balances are part of it unless `kind=regular` leaves them out.

`from` and `to` bound a search, not a stored value, so they may lie outside
the MySQL `TIMESTAMP` range that transaction timestamps are kept in
(1970-01-01T00:00:01Z to 2038-01-19T03:14:07Z): a month that starts on
1970-01-01T00:00:00Z, or in a zone east of UTC on the evening of
1969-12-31, opens like any other. Only the part of the period inside that
range can hold records; a period wholly outside it is `200` with no
`items`, a zero `summary` and no `day_totals`. `GET /transactions` and
`GET /transactions/count` select the same records for the same bounds, so
`summary.count` equals the count. Cursors keep the stored range: a cursor
position is always a stored record's timestamp.

Every malformed parameter is `400 VALIDATION_FAILED` with the parameter as
`field`, never corrected: a `q` of 256 characters is refused, not cut; a
`limit` of `0`, `101` or `1.5` is refused, not clamped; a repeated
parameter is refused. `cursor` together with `around_id` is
`400 VALIDATION_FAILED`, field `cursor`.

**Response `200`:**

```ts
interface TransactionFeed {
  items: TransactionView[]; // at most `limit`, newest first
  page_info: {
    next_cursor: string | null; // older records of the selection; null when there are none
    previous_cursor: string | null; // newer records of the selection; null when there are none
  };
  summary: {
    count: number; // records in the selection, initial balances included
    income: string; // "0.00": regular income of the selection
    expense: string; // "0.00": regular expense of the selection
  };
  day_totals: Array<{
    date: string; // YYYY-MM-DD in time_zone, a day of at least one record of items
    net: string; // "-12.30": income minus expense of that whole day of the selection
  }>;
}
```

- **Order.** `timestamp` descending, then `id` descending: the order of
  `GET /transactions`. Every page, also one read with `previous_cursor` or
  `around_id`, lists its items in this order.
- **One snapshot per response.** `items`, `summary` and `day_totals` of a
  response are read in one database snapshot, so they agree with each
  other even while other members write. The snapshot ends with the
  response: a cursor does not pin the database for the rest of the
  scrolling, and there is no frozen copy of the history (see below).
- **Computed in the database.** The count and the sums are aggregated by
  MySQL over the whole selection, never by loading its rows, and in exact
  decimal arithmetic: a sum may exceed the maximum of one amount
  (`"299999999.97"`). Day bounds are computed by the server in
  `time_zone`, with its daylight-saving changes (a local day can last 23 or
  25 hours), and do not depend on MySQL time zone tables.
- **Money** is a string with exactly two decimals; `net` carries a `-`
  when expense exceeds income and is `"0.00"`, never `"-0.00"`, when they
  are equal.
- **`summary`** covers the whole selection, not the page: it is the same
  on every page of one query, unless the data changed between the
  requests. `count` counts initial balances; `income` and `expense` leave
  them out, like the statistics.
- **`day_totals`** has one entry per local day (in `time_zone`) that has
  at least one record in `items`, in the order of `items`, newest day
  first, no day twice. `net` is income minus expense of **all** the
  records of that day in the selection, also those on other pages, so a
  day split between two pages has the same total on both and it does not
  change when the next page loads. A day is cut by `from` and `to`: the
  part of a day outside the period is not counted. Initial balances are
  left out of `net`; a day that only has an initial balance on the page is
  listed with `"0.00"`.
- **No records.** An empty selection, or a page past the end, is
  `items: []`, both cursors `null`, `day_totals: []`. `summary` still
  describes the selection (all zeros when it is empty).

#### Search

`q` keeps a record in the selection when its `description`, the name of
its category or the name of its wallet contains `q` as a substring. A
record that matches in several fields is listed and counted once.

- **Case and accents are ignored**, Cyrillic included: `кофе` finds
  `Кофе`, `елка` finds `Ёлка`, `cafe` finds `Café`. The server compares in
  one fixed collation (`utf8mb4_0900_ai_ci`), whatever the collation of the
  columns or the database default, so the result does not depend on how a
  database was set up.
- **No patterns:** `%`, `_` and `!` (the server's escape character) are
  plain characters, so `100%` finds only text with `100%` in it.
- **Archived categories and deleted wallets** are searched by their stored
  names. A record of a deleted wallet found by the wallet's name still reads
  `wallet: null` (the app shows "Deleted wallet"). This does not widen the
  `wallet_id` filter, which still takes only an active wallet.
- The system category's name is searched like any other: `q=Initial`
  finds the initial balances. The amount is not searched.

The 255-character limit counts Unicode code points after trimming, as the
description limit does. `q` combines with the period and every filter: the
server accepts any combination, even if the app does not offer it.

#### Cursors

A cursor is an opaque string: the client stores and sends it back
unchanged, never builds or parses it. It names a position in the order
(between two records), not a record, so it stays valid when the record it
was taken from is edited or deleted, and it does not expire.

- **`next_cursor`** continues after the last item of the page: the next
  `limit` records of the selection that are older in the order. `null` when
  the page ends with the oldest record of the selection.
- **`previous_cursor`** continues before the first item: the `limit`
  records immediately newer in the order, listed newest first. `null` when
  the page starts with the newest record of the selection (so it is always
  `null` on the first page).
- A cursor is at most 256 characters and carries its format version; a
  cursor of a format the server no longer reads is refused like any
  malformed one, and the client reloads the first page.
- A cursor belongs to its query: it is accepted only with the same `from`,
  `to`, `time_zone`, `q` (after trimming) and filters it was returned for.
  `limit` may change between pages. A cursor of another query, or one that
  is not a cursor at all, is `400 VALIDATION_FAILED`, field `cursor`: the
  client then reloads the first page.

Pages are read at different moments, each from the database as it is
then; the feed keeps no history session between requests. Records written
between two requests are not shifted into or out of the loaded pages. A record created or moved above the first loaded page is
reached by reloading the first page (pull to refresh). A record edited
between two requests can be listed on both pages, or on neither if its
timestamp moved across the loaded part. The client therefore keys records
by `id` and keeps the copy of the latest response, and takes `summary` and
the `day_totals` of a date from the latest response that carries them.
After a pull to refresh, or whenever it needs figures that agree across the
whole list, the client starts a new load from the first page.

#### Opening the history at a record

`around_id` returns the page that contains this transaction: the record
itself, up to `⌊(limit − 1) / 2⌋` records newer than it and older records
for the rest of the page. When one side has fewer records, the other side
fills the page (opened at the newest record of the selection, it is the
first page). `next_cursor` and `previous_cursor` continue from it in both
directions as usual, and `summary` and `day_totals` follow the usual rules.

| `around_id` is                                                        | Response                      |
| --------------------------------------------------------------------- | ----------------------------- |
| a transaction of the selection                                        | `200`, the page around it     |
| a transaction of the space outside the period, the search or a filter | `404 TRANSACTION_NOT_IN_FEED` |
| unknown, malformed, or a transaction of another space                 | `404 TRANSACTION_NOT_FOUND`   |

On `TRANSACTION_NOT_IN_FEED` the client opens the first page of the same
query; to open a record found elsewhere (home, statistics), it sends a
period that contains the record's timestamp, normally the month of it in
the device's zone.

#### Screens

| Screen                  | Request                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| History of a period     | the period's `from`/`to`, `time_zone`; then `cursor=next_cursor` while scrolling                              |
| Search in the history   | the same plus `q`; a changed `q` starts again without a cursor                                                |
| Period picker counter   | `GET /transactions/count` with the period; plus `q` while a search is open                                    |
| Statistics drill-down   | `AppliedFilter` as filters (`kind=regular`, `transaction_type`, `category_id`); no search while it is applied |
| Home, latest records    | `limit=5`, `from=1970-01-01T00:00:01Z`, `to=2038-01-19T03:14:07Z`; only `items` are used                      |
| History opened at a row | the record's month as `from`/`to`, `around_id`; cursors in both directions                                    |

**Errors**, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`FORBIDDEN_CATEGORY`, `FORBIDDEN_WALLET`, then `TRANSACTION_NOT_FOUND` and
`TRANSACTION_NOT_IN_FEED` for `around_id`.

**Relation to the other reads.** For the same `from`, `to`, `q` and
filters, `summary.count` equals `GET /transactions/count`. Without `q`, the
items of all the pages together are also the rows of `GET /transactions`
in the same order. `GET /transactions` and
`GET /transactions/latest` are kept unchanged; see
[Moving lists to the feed](#moving-lists-to-the-feed).

### `GET /spaces/:spaceId/transactions/operations/:operationId`

What became of the create sent with `client_operation_id: operationId`:

```ts
interface TransactionOperation {
  operation_id: string; // lowercase
  status: 'applied' | 'deleted';
  transaction_id: string;
  created_at: string; // when the create committed
  deleted_at: string | null; // null while the transaction exists
  transaction: TransactionView | null; // its current state; null when deleted
}
```

- `200 applied`: the create committed and the transaction exists.
  `transaction` is its current state, as `GET /:id` reads it; `version`
  above 1 means it was edited since (by anyone), and the client shows this
  state, not its own draft.
- `200 deleted`: the create committed, and the transaction was deleted
  later. It is not created again.
- `404 TRANSACTION_OPERATION_NOT_FOUND`: no create with this id committed in
  the space. A malformed id is the same `404`.

Any member of the space can ask. Operations are kept for as long as the
space exists, independently of the 24-hour `Idempotency-Key` retention, and
the answer is read in one snapshot. Records created without
`client_operation_id` (older clients, initial balances) cannot be looked up.

### `GET /spaces/:spaceId/transactions/:transactionId`

`200 TransactionView` for any transaction of the space: regular or initial
balance, on an active or deleted wallet, on an active or archived category.
It is the same object the list returns for that transaction.

Errors: `FORBIDDEN_SPACE` (checked first, so a non-member learns nothing
about the id), `TRANSACTION_NOT_FOUND`.

### `PATCH /spaces/:spaceId/transactions/:transactionId`

Headers: `If-Match: "<version>"`, required: the version the client read.
Without it the edit is refused with `428 TRANSACTION_VERSION_REQUIRED`.
`Idempotency-Key` is optional.

Request: any subset of the create fields.

```ts
interface UpdateTransactionRequest {
  wallet_id?: number;
  category_id?: number;
  transaction_type?: 'income' | 'expense';
  amount?: string;
  timestamp?: string;
  description?: string | null; // null, "" or whitespace clear it
}
```

| Field value                                   | Meaning                                             |
| --------------------------------------------- | --------------------------------------------------- |
| absent                                        | keep the current value                              |
| equal to the current value                    | keep the current value (no re-validation)           |
| `null` for `description`                      | clear the description                               |
| `null` for any other field                    | `400 VALIDATION_FAILED`, `<field> must not be null` |
| unknown field (`id`, `space_id`, `kind`, ...) | `400 VALIDATION_FAILED`                             |
| empty body                                    | no-op, `200` with the current state                 |

`null` is never a wallet or category id: a transaction on a deleted wallet
keeps it by leaving `wallet_id` out (or sending its own id).

The server merges the request into the current record and validates the
result:

| Check                                                       | Applies when                                | Error                              |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| The transaction is not the initial balance                  | always                                      | `400 TRANSACTION_IS_SYSTEM`        |
| `If-Match` equals the stored version                        | always                                      | `409 TRANSACTION_VERSION_CONFLICT` |
| Amount `0.01`–`99999999.99`, two decimals                   | `amount` changes                            | `400 VALIDATION_FAILED`            |
| Timestamp in range, not in the future                       | `timestamp` changes                         | `400 VALIDATION_FAILED`            |
| Wallet exists in the space                                  | `wallet_id` changes                         | `403 FORBIDDEN_WALLET`             |
| Wallet is not deleted                                       | `wallet_id` changes                         | `400 WALLET_DELETED`               |
| Category exists in the space and is not the system one      | `category_id` changes                       | `403 FORBIDDEN_CATEGORY`           |
| Category is not archived                                    | `category_id` changes                       | `400 CATEGORY_ARCHIVED`            |
| Resulting category type equals resulting `transaction_type` | `transaction_type` or `category_id` changes | `400 CATEGORY_TYPE_MISMATCH`       |

Request-shape errors (types, formats, description length, `null`s, unknown
fields, a malformed `If-Match` or `Idempotency-Key`) come before the record
is loaded, so a malformed request to a missing transaction is a `400`. Then
`TRANSACTION_VERSION_REQUIRED`, `FORBIDDEN_SPACE`, `IDEMPOTENCY_KEY_REUSED`,
`TRANSACTION_NOT_FOUND`, and the checks above in table order. Amount and
timestamp rules depend on the stored value, so they run after the record is
loaded. A failed edit changes nothing.

`200`:

```ts
interface UpdateTransactionResult {
  transaction: TransactionView; // the stored state after the edit, new version
  wallets: Array<{ id: number; balance: number; is_deleted: boolean }>;
}
```

`wallets` holds the current balance of every wallet the edit touched: one
entry, or two when `wallet_id` changed (the old wallet first). Each balance is
the sum of the wallet's history read after the edit, in the same DB
transaction and under the wallets' locks; nothing is added back or
subtracted by hand, and no balance is stored. A no-op edit
still returns its wallet and does not bump `version`.

### `DELETE /spaces/:spaceId/transactions/:transactionId`

Deletes a regular transaction, also one on a deleted wallet or an archived
category. `200` with the body `true`, as before. The record is removed;
there is no compensating "reverse" transaction.

Headers:

- `If-Match: "<version>"`, required: delete only if the record is still at
  the version the client read. Without it the delete is refused with
  `428 TRANSACTION_VERSION_REQUIRED`, so a delete never removes a version
  the user has not seen.
- `Idempotency-Key`, optional: a repeat answers `200 true` instead of `404`.

Errors, in check order: `VALIDATION_FAILED` (`If-Match`, `Idempotency-Key`),
`TRANSACTION_VERSION_REQUIRED`, `FORBIDDEN_SPACE`, `IDEMPOTENCY_KEY_REUSED`,
`TRANSACTION_NOT_FOUND`, `TRANSACTION_IS_SYSTEM`,
`TRANSACTION_VERSION_CONFLICT`.

| Result                    | Response                           | Client                                                   |
| ------------------------- | ---------------------------------- | -------------------------------------------------------- |
| Deleted                   | `200 true`                         | done                                                     |
| Already gone              | `404 TRANSACTION_NOT_FOUND`        | done: deleted by an earlier attempt or by another member |
| Changed since it was read | `409 TRANSACTION_VERSION_CONFLICT` | nothing deleted; offer to open the current details       |
| Access lost               | `403 FORBIDDEN_SPACE`              | leave the space                                          |
| Initial balance           | `400 TRANSACTION_IS_SYSTEM`        | not offered by the UI                                    |

With an `Idempotency-Key`, a repeat of a delete that succeeded answers
`200 true` again, so "already gone" then only means another member deleted
it. A repeat still checks access first.

**Undo of a create** is this same delete of the record the `POST` created,
with `If-Match` set to `transaction.version` from the `POST` result (`1`).
If another member, or another device, edited the record in between, undo
gets `409` and deletes nothing; the client offers to open `GET /:id`
instead of removing a version the user has not seen. Undo follows every
rule of an ordinary delete.

**Effects.** Deleting a record of a deleted wallet removes it from the
history, statistics and limit spending. It changes no active wallet's
balance, and `total_balance` only counts active wallets, so it is unchanged
too.

## Retries and concurrency

Two members of a shared space, or one user on two devices, can change the
same transaction at the same time, and a phone can lose the response to a
write the server did commit. Disabling a button on the phone protects
against neither, so the server guarantees the following.

### One DB transaction per write

Every transaction write (`POST`, `PATCH`, `DELETE`) runs as one MySQL
transaction (`READ COMMITTED`) that does, in this order:

1. lock the acting member's `space_members` row (shared) — the access check;
2. lock the `spaces` row (shared);
3. claim the `Idempotency-Key`, if sent;
4. lock the transaction row (exclusive), read it and check its version —
   `PATCH`, `DELETE`;
5. lock the wallet rows (exclusive, ascending id) — every wallet whose
   balance the write changes;
6. lock the category rows (shared);
7. check the domain rules, write, record the `client_operation_id` (a create
   with a used id waits here for the other create, then is refused), store
   the idempotent result.

Either all of it commits or nothing does. Every read after a lock sees the
latest committed state, so a membership removed, a wallet deleted or a
category archived by a request that committed first is seen and refused.

**Lock order.** Every write that takes more than one of these locks takes
them in the order above, so two writes never wait on each other crosswise:

| Operation                                                                   | Locks, in order                                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Transaction `POST` / `PATCH` / `DELETE`                                     | member (S), space (S), key, transaction (X), wallets (X, ascending id), categories (S), operation row |
| Category create, edit, archive, delete, reorder; limit create, edit, delete | member (S), space (X), then their own rows                                                            |
| Space delete                                                                | member rows (X), space (X)                                                                            |
| Member removal                                                              | member row (X)                                                                                        |
| Wallet rename, delete                                                       | member (S), space (S), wallet (X)                                                                     |
| Wallet create                                                               | member (S), space (S), the new rows; the system category (S) with an initial balance                  |

(S = shared, X = exclusive.) Consequences:

- Transaction writes in one space run side by side; writes to one wallet
  queue on its row, so `previous_balance` and the returned balances are
  exact.
- Category and limit changes take the space row exclusively, so they wait
  for in-flight transaction writes and the other way round: a category
  deleted while a transaction is being added to it is archived, not removed.
- Category and limit writes also hold the acting member's row until commit.
  Removal cannot overtake an authorized write; requests after removal are
  refused. Reordering validates and writes inside the same transaction,
  serialized with category archival and deletion.
- Wallet writes check access under the same member lock, so removing a
  member waits for their in-flight wallet write, and a write that starts
  after the removal committed is refused. Deleting a wallet waits for
  in-flight transaction writes to it.
- Moving a transaction between wallets locks both wallets in ascending id
  order, whichever is the source.
- MySQL may still detect a deadlock in rare cases (for example, two waiting
  repeats of one key after the first attempt failed). The server retries
  the whole unit up to three times before answering `500`.

### Versions and `If-Match`

`version` starts at 1 and grows by one with every real change of the
record. An edit that changes nothing does not bump it. A delete or an edit
sent with `If-Match: "<version>"` applies only if the stored version still
matches; otherwise the server answers `409 TRANSACTION_VERSION_CONFLICT`,
writes nothing, and the client re-reads `GET /:id` and lets the user decide.
The check runs under the transaction row lock, so of two concurrent edits
from the same version exactly one applies.

`If-Match` takes one version as a quoted entity tag: `"3"`; the bare `3` is
also accepted. A list, `*` or a weak tag (`W/"3"`) is
`400 VALIDATION_FAILED`. `PATCH` and `DELETE` require it.
`GET` responses carry no `ETag` header: the client reads `version` from the
body.

### Idempotency-Key

A write sent with an `Idempotency-Key` header is applied at most once:

- A repeat with the same key and the same request gets the result of the
  original success (same status and body), without applying the write
  again. A delete repeated this way answers `200 true`, not `404`.
- The same key with a different request (another body, transaction id or
  `If-Match`) is `409 IDEMPOTENCY_KEY_REUSED`.
- Concurrent repeats do not run in parallel: the second waits until the
  first commits and then gets its result, or, if the first failed, runs
  itself.
- The key and the result are stored in the database (`idempotency_keys`) in
  the same DB transaction as the write, never in process memory, so they
  survive restarts and are shared between instances.
- A key is scoped to the user, the space and the operation
  (`transactions.create`, `transactions.update`, `transactions.delete`):
  the same key from another user, in another space or for another operation
  is a different key. Keys are compared byte for byte.
- A repeat runs the access check first: a member who lost access gets
  `403 FORBIDDEN_SPACE`, not the stored result.
- Only successes are stored. A refused request (`400`, `403`, `404`, `409`)
  stores nothing, so repeating it runs it again against the current state.

Format: 1–255 printable ASCII characters without spaces; the client
generates a UUID per user action and reuses it for every retry of that
action, including after an app restart. Anything else is
`400 VALIDATION_FAILED`.

**Safe replay window: 24 hours.** A key is kept for exactly 24 hours from
the original request (`IDEMPOTENCY_KEY_TTL_MS`). Within the window a repeat
gets the original response. After it the key is forgotten and a repeat runs
as a new request: a create without `client_operation_id` creates a second
transaction, one with it is `409 TRANSACTION_OPERATION_EXISTS`. Expired keys
are deleted by a background job of the application every 10 minutes, never
on a request's path; the job skips keys a request is holding instead of
waiting for them.

The window only bounds how long the original _response_ can be replayed.
Whether a create happened at all is answered, without a time limit, by
`client_operation_id` and its lookup; see
[Recovering an unfinished create](#recovering-an-unfinished-create). The
client counts the window from its first send of the action, on its own
clock, and treats it as closed after 23 hours to stay clear of the edge.

### What the client does on a failure

| Situation                          | Without a key                                  | With a key              |
| ---------------------------------- | ---------------------------------------------- | ----------------------- |
| `POST`, response lost              | a retry creates a second transaction¹          | retry: original result² |
| `PATCH`, response lost             | retry: `409` (its own edit bumped the version) | retry: original result  |
| `DELETE`, response lost            | retry: `404`, treated as done                  | retry: `200 true`       |
| `409 TRANSACTION_VERSION_CONFLICT` | re-read `GET /:id`, let the user decide        | same                    |
| `5xx` or timeout                   | the write may or may not have applied          | retry with the same key |

¹ Unless the request carries `client_operation_id`: a retry is then
`409 TRANSACTION_OPERATION_EXISTS`. ² Within 24 hours; after that, or
whenever the client is unsure, see below.

`GET` is always safe to repeat.

### Recovering an unfinished create

A create the client sent but has no answer for (no network, timeout, `5xx`,
app killed) has an unknown outcome. The client never decides it by finding
a transaction with the same amount, date and category: two real purchases
can match exactly, and the record may have been edited or deleted since.
Only `client_operation_id` identifies the create.

Each pending create on the device keeps: the request body, its
`client_operation_id` (also used as its `Idempotency-Key`) and the time of
its first send. Its states:

| State       | Meaning                                    | Next                                                                     |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `queued`    | not sent yet (offline)                     | send when online → `sending`                                             |
| `sending`   | sent, waiting for the answer               | see the answers below                                                    |
| `unknown`   | sent, no answer                            | within 23 h of the first send: resend → `sending`; later: look up        |
| `checking`  | `GET /transactions/operations/:id` is sent | see the lookup answers below                                             |
| `synced`    | the create committed; server record known  | final: show the server record                                            |
| `discarded` | it committed but was deleted since         | final: drop the draft; tell the user it was deleted elsewhere            |
| `failed`    | refused by a rule (`400`, `403`)           | final: show the error; the user fixes and sends as a new action (new id) |

Answers to a send (`POST`, the same body, id and key every time):

| Answer                             | Next state                                          |
| ---------------------------------- | --------------------------------------------------- |
| `201`                              | `synced`, with the returned record                  |
| `409 TRANSACTION_OPERATION_EXISTS` | `checking`                                          |
| `400`, `403` on the first send     | `failed`                                            |
| `400`, `403` on a resend           | `checking` first: the first send may have committed |
| `409 IDEMPOTENCY_KEY_REUSED`       | `checking` (the body changed on the device: a bug)  |
| no answer, timeout, `5xx`          | `unknown`                                           |
| `401`, `429`                       | stay; resend after re-login / back-off              |

Answers to a lookup:

| Answer                                | Next state                                                   |
| ------------------------------------- | ------------------------------------------------------------ |
| `200 applied`                         | `synced`, with `transaction` (edited since if `version` > 1) |
| `200 deleted`                         | `discarded`                                                  |
| `404 TRANSACTION_OPERATION_NOT_FOUND` | resend the same body with the same id → `sending`            |
| `403 FORBIDDEN_SPACE`                 | `failed`: access to the space was lost                       |
| no answer, `5xx`                      | stay `checking`; ask again later                             |

A resend after `404` is safe even if the original request is still in flight
on the server: the id is unique, so of the two at most one commits and the
other is `409 TRANSACTION_OPERATION_EXISTS`. Because the operation is kept
as long as the space, a device that comes back after weeks resolves every
pending create the same way, without creating any of them twice.

The other writes need no lookup: the outcome of an edit or a delete is the
record's current state. After a lost `PATCH` the client re-reads
`GET /:id` (an unknown edit may or may not be in it; a retry with the old
`If-Match` is `409` if it was); after a lost `DELETE`, `404` means the
record is gone.

## Effects on derived data

Every derived figure is computed from history at read time, so a create,
edit or delete is reflected by the next read; nothing stored is patched.
`GET /wallets` reads the wallets, their balances and period totals, and
`GET /limits` reads the limits and their spending, each in one database
snapshot: a write committed during the request is in none of its figures or
in all of them, never in a balance but not in the totals.

`GET /categories` likewise reads category state, transaction counts and
limit links from one snapshot. Concurrent archival cannot return an active
category combined with the link removals of the archived state.

| Figure                                        | Initial balance | Regular transactions                               |
| --------------------------------------------- | --------------- | -------------------------------------------------- |
| History rows, `GET /transactions/count`       | included        | in `from`..`to`, by the filters                    |
| Feed `items`, `summary.count`                 | included        | in `from`..`to`, by `q` and the filters            |
| Feed `summary.income` / `summary.expense`     | excluded        | in `from`..`to`, by `q` and the filters            |
| Feed `day_totals` `net`                       | excluded        | the local day within `from`..`to`, by `q`, filters |
| Wallet `balance`, `total_balance`             | included        | all, whatever their timestamp                      |
| Statistics Income / Expense / Net             | excluded        | up to `as_of`, by `transaction_type`               |
| `GET /wallets` `total_income` / `total_spend` | excluded        | in the period                                      |
| Limits `spent`                                | excluded        | expenses of the month in `time_zone`, by category  |
| Category `transaction_count`                  | not shown       | all, whatever their timestamp                      |

Moving a transaction to another wallet moves its amount from one balance to
the other. Changing its type, category, amount or timestamp moves it
between Income and Expense, categories, limits and periods accordingly. A
day's financial total in the history is the feed's `day_totals`, computed by
the server; the client no longer adds up loaded rows.

### Limits period

`GET /limits?time_zone=<IANA>` counts `spent` over the current calendar
month in that zone and returns the month it counted:

```ts
interface LimitsSummary {
  period: {
    time_zone: string; // canonical IANA name
    start_date: string; // first local day, YYYY-MM-DD
    end_date: string; // last local day
    from: string; // first instant, ISO UTC
    to: string; // last instant, inclusive, to the millisecond
  };
  // LimitView as before: id, name, amount, spent, in_percent, categories
  total: LimitView | null;
  categories: LimitView[];
  over_allocation: { category_total: number; difference: number } | null;
}
```

The mobile client sends the device's zone, as for statistics, and every
screen showing limit spending takes the month from `period`; a history or
statistics request for "this month's" figures uses `period.from` and
`period.to`. A fixed offset (`+03:00`) or an unknown zone is
`400 VALIDATION_FAILED`, field `time_zone`. Without `time_zone` the month is
the server's, as before (kept for older clients).

The monthly total limit (`limit_type: 'others'`, no categories) counts
**every** expense of the month, those of categories with their own limit
included; it is not a budget for the categories left without one. A
category limit counts the expenses of its categories.

### Comparing figures

Figures agree when they are asked for the same thing: the same filters and
the same instants. Compare a statistics block with the history using its
`period.from` and `actual_to` (not `to`: a current period stops at
`as_of`), and the limits with the history using the limits `period`. A
history day or month is bounded by the device's zone, sent as instants with
an offset.

## Errors

Every error body carries a stable `code` next to the existing fields; the
client branches on `statusCode` and `code`, never on `message`, which is
English display text and may change.

```json
{
  "timestamp": "2026-10-05T10:00:00.000Z",
  "path": "/api/v1/spaces/1/transactions/…",
  "statusCode": 400,
  "requestId": "…",
  "code": "CATEGORY_TYPE_MISMATCH",
  "message": "The category type does not match the transaction type"
}
```

| Status | `code`                            | When                                                                   |
| ------ | --------------------------------- | ---------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`               | Request shape, field rule or header; `message` is `[{ field, error }]` |
| 400    | `TRANSACTION_IS_SYSTEM`           | `PATCH`/`DELETE` of the initial balance                                |
| 400    | `WALLET_DELETED`                  | A deleted wallet chosen on create, or a different deleted one on edit  |
| 400    | `CATEGORY_ARCHIVED`               | An archived category chosen on create, or a different one on edit      |
| 400    | `CATEGORY_TYPE_MISMATCH`          | The resulting category type differs from the transaction type          |
| 400    | `BAD_REQUEST`                     | A non-numeric `:spaceId`                                               |
| 401    | `UNAUTHORIZED`                    | Missing, invalid or revoked token                                      |
| 403    | `FORBIDDEN_SPACE`                 | Not a member, or no such space                                         |
| 403    | `FORBIDDEN_WALLET`                | No such wallet in the space                                            |
| 403    | `FORBIDDEN_CATEGORY`              | No such category in the space, or the system category                  |
| 404    | `TRANSACTION_NOT_FOUND`           | No such transaction in the space, or a malformed id                    |
| 404    | `TRANSACTION_OPERATION_NOT_FOUND` | No create with this `client_operation_id` committed in the space       |
| 404    | `TRANSACTION_NOT_IN_FEED`         | The feed's `around_id` is outside the period, the search or a filter   |
| 409    | `TRANSACTION_VERSION_CONFLICT`    | `If-Match` differs from the stored version                             |
| 409    | `IDEMPOTENCY_KEY_REUSED`          | The `Idempotency-Key` was used for a different request                 |
| 409    | `TRANSACTION_OPERATION_EXISTS`    | The `client_operation_id` was already used in the space                |
| 428    | `TRANSACTION_VERSION_REQUIRED`    | `PATCH` or `DELETE` without `If-Match`                                 |
| 429    | `TOO_MANY_REQUESTS`               | Rate limit                                                             |
| 500    | `INTERNAL_SERVER_ERROR`           | Unexpected server failure; details only in the log                     |

Codes are the same on every endpoint of the API, not only on transactions:
a domain error carries its own code (`FORBIDDEN_LIMIT`, `CATEGORY_IS_SYSTEM`,
...), field errors carry `VALIDATION_FAILED`, and any other error carries
the HTTP status name. An unexpected server failure is
`500 INTERNAL_SERVER_ERROR` with the fixed message "Internal server error"
and the `requestId` to quote; its details are only in the server log. See
[What the client does on a failure](#what-the-client-does-on-a-failure).

In `VALIDATION_FAILED`, `field` is stable and names the request field or
header (`If-Match`, `Idempotency-Key`); `error` is display text.

## Examples

Bodies are trimmed to what matters; every error also carries `timestamp`,
`path`, `statusCode` and `requestId`.

### Create, with a retry after a lost response

```http
POST /api/v1/spaces/1/transactions
Idempotency-Key: 0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70

{ "wallet_id": 7, "category_id": 12, "transaction_type": "expense",
  "amount": "12.3", "timestamp": "2026-09-15T13:00:00+03:00", "description": "  Lunch " }
```

```http
201
{ "transaction": { "id": "9b1d…", "kind": "regular", "transaction_type": "expense",
                   "amount": "12.30", "timestamp": "2026-09-15T10:00:00.000Z",
                   "description": "Lunch", "version": 1,
                   "wallet": { "id": 7, "wallet_name": "Card", … },
                   "category": { "id": 12, "name": "Grocery", "is_archived": false, … } },
  "wallet": { "id": 7, "wallet_name": "Card", …, "balance": 87.7 },
  "previous_balance": 100 }
```

The response is lost; the app sends the same request with the same key and
gets the same `201` body. No second transaction is created. Sending the key
with another body is `409 IDEMPOTENCY_KEY_REUSED`.

### Create, recovered after days offline

The same create with `"client_operation_id": "0f8e3b1c-…"` and the same key
was sent three days ago and its answer was lost. The key has expired, so the
app looks the operation up instead of resending:

```http
GET /api/v1/spaces/1/transactions/operations/0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70

200
{ "operation_id": "0f8e3b1c-…", "status": "applied", "transaction_id": "9b1d…",
  "created_at": "2026-09-15T10:00:01.204Z", "deleted_at": null,
  "transaction": { "id": "9b1d…", "amount": "20.00", "version": 2, … } }
```

It committed and was edited since (`version: 2`); the app shows this record.
Had another member deleted it, the answer would be `"status": "deleted"`,
`"transaction": null`, and the app drops the draft. A `404` means it never
committed: the app resends the same body with the same id. Resending
without the lookup is also safe:

```http
409
{ "code": "TRANSACTION_OPERATION_EXISTS",
  "message": "A transaction was already created for this client_operation_id" }
```

### Edit

```http
PATCH /api/v1/spaces/1/transactions/9b1d…
If-Match: "1"

{ "amount": "20", "wallet_id": 8 }
```

```http
200
{ "transaction": { "id": "9b1d…", "amount": "20.00", "version": 2,
                   "wallet": { "id": 8, … }, … },
  "wallets": [ { "id": 7, "balance": 100, "is_deleted": false },
               { "id": 8, "balance": -20, "is_deleted": false } ] }
```

The same edit sent again with `If-Match: "1"` (for example by a second
member who read the same version) is refused:

```http
409
{ "code": "TRANSACTION_VERSION_CONFLICT", "message": "The transaction was changed since it was read" }
```

The client re-reads `GET /transactions/9b1d…` (`version: 2`) and lets the
user decide. Without `If-Match`:

```http
428
{ "code": "TRANSACTION_VERSION_REQUIRED", "message": "If-Match with the version that was read is required" }
```

A field error:

```http
400
{ "code": "VALIDATION_FAILED",
  "message": [ { "field": "amount", "error": "amount must be greater than 0" } ] }
```

### Delete and undo

Undo right after the create above:

```http
DELETE /api/v1/spaces/1/transactions/9b1d…
If-Match: "1"
Idempotency-Key: 4c2a…
```

`200 true`. Repeated with the same key, `200 true` again; without a key,
`404 TRANSACTION_NOT_FOUND`, which the client also treats as done. If
another member edited the record first, `409 TRANSACTION_VERSION_CONFLICT`
and nothing is deleted. Deleting the initial balance:

```http
400
{ "code": "TRANSACTION_IS_SYSTEM", "message": "The initial balance cannot be edited or deleted" }
```

### History, count and limits for this month

```http
GET /api/v1/spaces/1/limits?time_zone=Europe/Moscow

200 { "period": { "time_zone": "Europe/Moscow", "start_date": "2026-10-01",
                  "end_date": "2026-10-31", "from": "2026-09-30T21:00:00.000Z",
                  "to": "2026-10-31T20:59:59.999Z" },
      "total": { "id": 3, "amount": "1000.00", "spent": 20, "in_percent": 2, … }, … }

GET /api/v1/spaces/1/transactions?from=2026-09-30T21:00:00.000Z&to=2026-10-31T20:59:59.999Z
GET /api/v1/spaces/1/transactions/count?from=2026-09-30T21:00:00.000Z&to=2026-10-31T20:59:59.999Z

200 { "count": 5 }
```

### Feed: first page, next page, search, opening at a record

The October history in Moscow time, 50 per page:

```http
GET /api/v1/spaces/1/transactions/feed?from=2026-09-30T21:00:00.000Z&to=2026-10-31T20:59:59.999Z&time_zone=Europe/Moscow

200
{ "items": [
    { "id": "f3a0…", "kind": "regular", "transaction_type": "expense", "amount": "12.30",
      "timestamp": "2026-10-12T09:15:00.000Z", "version": 1, … },
    …,
    { "id": "07c4…", "kind": "regular", "transaction_type": "expense", "amount": "4.00",
      "timestamp": "2026-10-03T08:00:00.000Z", "version": 1, … } ],
  "page_info": { "next_cursor": "eyJ2IjoxLC…", "previous_cursor": null },
  "summary": { "count": 73, "income": "2500.00", "expense": "1184.45" },
  "day_totals": [ { "date": "2026-10-12", "net": "-12.30" },
                  …,
                  { "date": "2026-10-03", "net": "-31.50" } ] }
```

The page ends inside October 3: `-31.50` is the whole day, also the records
of October 3 that are not loaded yet. Scrolling on:

```http
GET /api/v1/spaces/1/transactions/feed?from=2026-09-30T21:00:00.000Z&to=2026-10-31T20:59:59.999Z&time_zone=Europe/Moscow&cursor=eyJ2IjoxLC…

200
{ "items": [ { "id": "05d1…", "timestamp": "2026-10-03T07:40:00.000Z", … }, …,
             { "id": "c9e2…", "kind": "initial_balance", "transaction_type": "income",
               "amount": "100.00", "timestamp": "2026-10-01T06:00:00.000Z", … } ],
  "page_info": { "next_cursor": null, "previous_cursor": "eyJ2IjoxLC…" },
  "summary": { "count": 73, "income": "2500.00", "expense": "1184.45" },
  "day_totals": [ { "date": "2026-10-03", "net": "-31.50" }, …,
                  { "date": "2026-10-01", "net": "0.00" } ] }
```

October 3 has the same total as on the first page. October 1 only has the
initial balance, so its `net` is `"0.00"`; the initial balance is counted
in `count` but not in `income`. `next_cursor: null`: the history ends here.

A search with no match, `q` sent as `" coffee  "` (trimmed to `"coffee"`):

```http
GET /api/v1/spaces/1/transactions/feed?from=2026-09-30T21:00:00.000Z&to=2026-10-31T20:59:59.999Z&time_zone=Europe/Moscow&q=%20coffee%20%20

200
{ "items": [],
  "page_info": { "next_cursor": null, "previous_cursor": null },
  "summary": { "count": 0, "income": "0.00", "expense": "0.00" },
  "day_totals": [] }
```

Opening the history at a record from the home screen, 5 records per page
to keep the example short:

```http
GET /api/v1/spaces/1/transactions/feed?from=2026-09-30T21:00:00.000Z&to=2026-10-31T20:59:59.999Z&time_zone=Europe/Moscow&limit=5&around_id=8a61…

200
{ "items": [ { "id": "b2f7…", "timestamp": "2026-10-09T18:00:00.000Z", … },
             { "id": "41aa…", "timestamp": "2026-10-09T12:30:00.000Z", … },
             { "id": "8a61…", "timestamp": "2026-10-09T10:00:00.000Z", … },
             { "id": "e05c…", "timestamp": "2026-10-08T19:20:00.000Z", … },
             { "id": "6d13…", "timestamp": "2026-10-08T07:05:00.000Z", … } ],
  "page_info": { "next_cursor": "eyJ2IjoxLC…", "previous_cursor": "eyJ2IjoxLC…" },
  "summary": { "count": 73, "income": "2500.00", "expense": "1184.45" },
  "day_totals": [ { "date": "2026-10-09", "net": "-56.00" },
                  { "date": "2026-10-08", "net": "1450.00" } ] }
```

Two newer records, the record, two older ones. `previous_cursor` loads the
records above it (newer), `next_cursor` the ones below. The same
`around_id` with a period that does not contain the record:

```http
404
{ "code": "TRANSACTION_NOT_IN_FEED",
  "message": "The transaction does not match the period, search or filters" }
```

A cursor sent with another `q` or period:

```http
400
{ "code": "VALIDATION_FAILED",
  "message": [ { "field": "cursor", "error": "cursor does not belong to this query" } ] }
```

## Migration and compatibility

### Moving lists to the feed

`GET /transactions/feed` is added next to the existing reads; nothing that
an installed app calls changes.

1. The backend adds `/feed`; `GET /transactions` keeps returning the plain
   array, unchanged. Its shape is never switched to a paged object in
   place: an older app would break on it.
2. The mobile app moves every list (history, search, statistics
   drill-down, home) to `/feed` and stops computing day totals and period
   income/expense from loaded rows.
3. `GET /transactions` is then marked deprecated in the OpenAPI document.
   Removing it is a separate change, once older app versions are no longer
   supported.

`GET /transactions/latest`, `GET /transactions/count`, `GET /:id`,
operations and every write stay as they are.

### Deployment order

1. Run the migrations, in this order (`npm run migration:run:prod`, see
   [`deployment.md`](deployment.md)):
   - `1790200000000-AddTransactionVersion`: `transactions.version`,
     `INT UNSIGNED NOT NULL DEFAULT 1`; existing rows start at 1;
   - `1790300000000-CreateIdempotencyKeys`: the `idempotency_keys` table;
   - `1790400000000-CreateTransactionOperations`: the
     `transaction_operations` table (rows removed with their space).
   - `1790500000000-ExtendTransactionWalletTimestampIndex`: replaces the
     `(wallet_id, timestamp)` index with one the feed pages and totals read
     (online, see [`feed-performance.md`](feed-performance.md#index)).
2. Check the schema (`node dist/database/check-schema.js`).
3. Deploy the application.

The new application refuses to start until every migration of its build has
run (see [`deployment.md`](deployment.md#schema-check)), so it is never
released on the old schema. The migrations only add a column and tables and
widen an index, so
the application version before this contract keeps working on the migrated
schema and starts with a warning about the migrations it does not know. Rolling back the application does not need a
schema rollback. `migration:revert` restores the narrower index, drops the
tables, then the column.
No data is rewritten: legacy zero amounts, future timestamps, `""`
descriptions and type/category mismatches stay as they are (see
[Compatibility with existing records](#compatibility-with-existing-records)).
Expired idempotency keys are removed by the application's own background
job; no external scheduler is needed.

### An older client against the new API

| Request of an older client                                                        | Result now                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /transactions`, `/latest`                                                    | works; new fields are added, `""` description reads as `null`           |
| `POST /transactions` with a valid, past, positive expense                         | works; `transaction` has more fields and a 2-decimal `amount`           |
| `POST` with `amount: "0"`, a future timestamp, an archived or wrong-type category | `400` (was accepted)                                                    |
| `POST` with a date-only or offset-less `timestamp`                                | `400` (was read in server local time)                                   |
| `POST` on a deleted wallet                                                        | `400 WALLET_DELETED` (was `403 FORBIDDEN_WALLET`)                       |
| `DELETE` (undo) without `If-Match`                                                | **`428 TRANSACTION_VERSION_REQUIRED`** (was `200`)                      |
| `DELETE` of a missing transaction                                                 | `404 TRANSACTION_NOT_FOUND` (was `403 FORBIDDEN_WALLET`)                |
| `GET /wallets`                                                                    | works; `total_income`, `delta_percent` no longer count initial balances |
| `GET /limits` without `time_zone`                                                 | works; month of the server as before, plus a `period` key               |
| Any error                                                                         | works; bodies gain `code`                                               |

Undo without `If-Match` is the one break that an older build hits in normal
use; the new mobile build ships before or together with this backend.

### Mobile checklist

- Read the transaction view everywhere: `kind` decides whether a record is
  editable (`initial_balance` is read-only), `wallet: null` means a deleted
  wallet, `category.is_archived` an archived category.
- Keep `version` from every read and write; send it as `If-Match: "<n>"`
  on `PATCH` and `DELETE`, including undo (`version` from the `POST`
  result). On `409`, re-read `GET /:id` and offer the current details.
- Generate one UUID per create and send it both as `Idempotency-Key` and as
  `client_operation_id`, on every retry of that create; persist it with the
  pending create. Within 23 hours of the first send, retry; after that, or
  on `409 TRANSACTION_OPERATION_EXISTS`, resolve it with
  `GET /transactions/operations/:id` (see
  [Recovering an unfinished create](#recovering-an-unfinished-create)).
  Never decide a create by matching amount, date and category.
- Generate one `Idempotency-Key` per edit or delete and reuse it for its
  retries, for at most 24 hours.
- Send timestamps with an offset, and history bounds as instants of the
  device's day or month; pass the device's IANA zone to statistics and
  limits; take "this month" from the limits `period`.
- Edit with `PATCH`, sending only what changed or the whole form; leave
  `wallet_id`/`category_id` out (or send the current ids) to keep a deleted
  wallet or an archived category.
- Use `GET /transactions/count` for the calendar counter, with the open
  search's `q` so that it counts the matches; decide "no history" from rows
  or the count, never from Income being zero.
- Load every transaction list from `GET /transactions/feed` (see
  [Moving lists to the feed](#moving-lists-to-the-feed)): store cursors as
  opaque strings, key records by `id`, and show `summary` and `day_totals`
  as the server returns them instead of adding up loaded rows.
- Branch on `statusCode` and `code`, never on `message`.

### Changes against the previous API

- **New:** `GET /transactions/:id`, `PATCH /transactions/:id`,
  `GET /transactions/count`; `kind`, `version` and `category.is_archived`
  on every transaction read; `version` on the `POST` results'
  `transaction`; `code` on every error of the API; optional
  `Idempotency-Key` on every write; optional `time_zone` and a `period` key
  on `GET /limits`; optional `client_operation_id` on `POST` and
  `GET /transactions/operations/:operationId`; `GET /transactions/feed`
  with cursor pages, search and server totals; optional `q` on
  `GET /transactions/count`.
- **`If-Match` required on `DELETE` (breaking):** a delete or undo without
  it is `428 TRANSACTION_VERSION_REQUIRED`.
- **`POST` is stricter:** a zero amount, a timestamp more than a minute
  ahead or without an offset, an archived category and a category of the
  other type are refused. A deleted wallet is `400 WALLET_DELETED` instead
  of `403 FORBIDDEN_WALLET`. The `CATEGORY_ARCHIVED` message is now generic
  ("The category is archived"), also on limits.
- **`POST` response:** `transaction` is the full transaction view; its
  `amount` has two decimals instead of echoing the request string.
- **`description`:** `""` and whitespace-only input are stored as `null`,
  input is trimmed, and legacy `""` is read as `null`.
- **`DELETE`:** a missing or foreign transaction is
  `404 TRANSACTION_NOT_FOUND` instead of `403 FORBIDDEN_WALLET`; the initial
  balance can no longer be deleted (`400 TRANSACTION_IS_SYSTEM`).
- **`GET /wallets`:** `total_income` and `delta_percent` stop counting the
  initial balance, matching the statistics API.
- **History:** rows with an equal timestamp are ordered by `id`; `from`
  after `to` is `400`.
