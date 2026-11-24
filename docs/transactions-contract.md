# Transactions API contract

The rules of creating, reading, editing and deleting the transactions of one
space: domain rules, field rules, compatibility with records written under
older rules, history selection and the feed, retries and concurrency, and
machine-readable errors. It is the source of truth for the backend and the
mobile integration, together with the
[v2 contract](transactions-v2-contract.md), which defines the routes, the
request and response shapes, the author and the assignment of a record.
Where the two overlap, the v2 contract wins.

The routes are under `/api/v2/spaces/:spaceId/transactions`. The `/api/v1`
transaction routes, the wallets and the v1 statistics were retired in
Release B: they answer `410 LEGACY_API_RETIRED`
([v2 contract](transactions-v2-contract.md#release-b)).

Out of scope: several currencies in one space, moving a transaction to
another space, and scheduled or recurring transactions.

## Implementation status

| Part                                                                                    | Status      |
| --------------------------------------------------------------------------------------- | ----------- |
| `code` on every error response                                                          | implemented |
| Transaction view with `kind`, `version`, compact category                               | implemented |
| One locked DB transaction per write, `Idempotency-Key`                                  | implemented |
| `PATCH` and `DELETE` with `If-Match`                                                    | implemented |
| `client_operation_id`, `GET /transactions/operations/:id`                               | implemented |
| `GET /transactions/feed`: cursor pages, search, `around_id`, `summary`, `day_totals`    | implemented |
| `GET /transactions/count`, stable history order                                         | implemented |
| Limits month in the client's `time_zone`                                                | implemented |
| Calendar `date` instead of `timestamp`, date-bounded history (Release C)                | implemented |
| Wallets, the v1 transaction routes and their balances (Release B: `410`, table dropped) | removed     |

Code: `src/modules/transactions` (`space-transactions.service.ts`, the write
unit in `transaction-writes.ts`, the feed in `transaction-feed-reader.ts`,
the view in `transaction-view.ts`, OpenAPI schemas in `dto/`), operations in
`entities/transaction-operation.entity.ts`, `src/modules/idempotency`, error
codes in `src/shared/error-messages.ts` and `http-exception.filter.ts`.
Tests: the unit specs next to the code, `test/transactions.e2e-spec.ts`,
`test/transaction-writes.e2e-spec.ts` (repeats, concurrent writes and access
revocation against MySQL), `test/transaction-operations.e2e-spec.ts`
(recovering a create after the key expired),
`test/transaction-lifecycle.e2e-spec.ts` (the full lifecycle with every
derived figure after each step, DST, and the OpenAPI document),
`test/api-contract.e2e-spec.ts` (`PATCH` as the edit, required versions, the
maximum amount on every money field, the monthly total limit, the retired
routes), the feed specs (`test/transaction-feed*.e2e-spec.ts`) and the
response shapes in `test/type-contract.e2e-spec.ts`; the e2e tests check the
feed, latest and details responses against their OpenAPI schemas.

## Domain rules

1. **One space, one category.** A transaction belongs to exactly one space
   (`space_id`) and one category of that space. It never moves to another
   space: a category of another space is refused like a missing one.
2. **Type gives the direction.** `transaction_type` is `income` or
   `expense`. `amount` is a non-negative decimal string; its sign never
   carries the direction.
3. **Space currency.** Amounts are in the space's currency (`Space.currency`).
   Transactions have no currency of their own.
4. **Amount.** A new or changed amount is greater than zero, at most
   `99999999.99`, with at most two decimal places. Invalid input is refused,
   never rounded or truncated.
5. **Description.** Optional, at most 140 characters. A missing description
   is always `null`: the server trims the input, and an empty result is
   stored and returned as `null`, never `""`.
6. **Date.** A transaction happens on a calendar day (`date`), with no
   time of day and no zone. A new or changed date is not after today in
   the writer's zone (see [Date](#date)).
7. **Choosing a category.** A new transaction takes an active (not
   archived), non-system category whose type equals `transaction_type`.
8. **Keeping the original category on edit.** An edit may keep the
   transaction's own category even if it was archived since. It may not move
   the transaction to another archived category.
9. **Type and category agree.** When `transaction_type` or `category_id`
   changes, the resulting category's type must equal the resulting
   transaction type.
10. **Final state is checked.** An edit is validated as the record it
    produces (current values merged with the request), not field by field.
11. **Starting balances are system records.** The starting balances the
    wallets of earlier releases recorded are `income` transactions on the
    space's system category ("Initial balance"). They can be read, but not
    edited or deleted, and no regular transaction can be moved onto the
    system category. No new one is created.
12. **What counts where.** A starting balance is part of the history, but
    not of Income, Expense, Net, limits or a day's financial total (see
    [Effects on derived data](#effects-on-derived-data)).

The author and the assignment of a record, and who may change them, are in
the [v2 contract](transactions-v2-contract.md#domain-rules).

## Endpoints

All routes require the bearer token and membership in the target space.
`category_id` is a positive integer within the signed MySQL `INT` range
(1–2147483647); invalid values return `400 VALIDATION_FAILED`. Limit
`category_ids` follow the same range and must not repeat.

Checks run in this order: request shape (`400 VALIDATION_FAILED`, before
anything is read), membership (`403 FORBIDDEN_SPACE`), then the endpoint's
own checks.

| Method   | Route                                                          |
| -------- | -------------------------------------------------------------- |
| `POST`   | `/api/v2/spaces/:spaceId/transactions`                         |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/feed`                    |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/latest`                  |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/count`                   |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/assignees`               |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/operations/:operationId` |
| `GET`    | `/api/v2/spaces/:spaceId/transactions/:transactionId`          |
| `PATCH`  | `/api/v2/spaces/:spaceId/transactions/:transactionId`          |
| `DELETE` | `/api/v2/spaces/:spaceId/transactions/:transactionId`          |

Transaction lists are read only through `GET .../transactions/feed`, in
cursor pages; there is no unpaged list (`GET .../transactions` is
`404 NOT_FOUND`).

`PATCH` is a partial update: an absent field keeps its current value. There
is no `PUT`.

`:transactionId` is a UUID. A malformed id, an unknown id and the id of a
transaction of another space all give `404 TRANSACTION_NOT_FOUND`, so a
member cannot tell a foreign transaction from a missing one. `feed`,
`latest`, `count`, `assignees` and `operations` are reserved path segments,
never ids. A non-numeric `:spaceId` is `400 BAD_REQUEST`.

## Field rules

### Amount

| Rule   | Accepted                                                                  | Rejected (`400 VALIDATION_FAILED`, field `amount`)          |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Type   | decimal `string`                                                          | JSON number, `null`                                         |
| Format | digits, optionally `.` and one or two digits: `"12"`, `"12.3"`, `"12.30"` | sign (`"-1"`, `"+1"`), `".5"`, `"5."`, exponent, whitespace |
| Scale  | at most two decimal places                                                | `"1.234"`, `"1.230"`; never rounded or truncated            |
| Range  | `0.01` to `99999999.99` inclusive                                         | `"0"`, `"0.00"`, `"100000000"` and anything above           |

These are the money rules of [`type-contract.md`](type-contract.md#money-rules)
with zero excluded for transactions. Limit amounts keep accepting zero.

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

### Date

- A calendar date, exactly `YYYY-MM-DD` (`2026-09-15`), a real day
  (`2028-02-29` is one, `2026-02-29` is not), from `1000-01-01` to
  `9999-12-31`. A date-time, an offset, `Z` or another layout is
  `400 VALIDATION_FAILED`, field `date`. Reads return the stored value,
  so echoing one back is fine.
- Sent together with `time_zone`, the device's IANA zone
  (`Europe/Moscow`): required on create, and on a `PATCH` whenever `date`
  is sent (`400 VALIDATION_FAILED`, field `time_zone`, otherwise). It only
  tells which day is today for the writer; it is not stored and never
  changes the date. A fixed offset (`+03:00`) or an unknown zone is
  refused.
- Not after today: today is the date in `time_zone` of the server clock
  plus **60 seconds**, a margin for device clock drift. A later date is
  `400 VALIDATION_FAILED`, field `date`.
- `timestamp` is not a field: a body with it is `400 VALIDATION_FAILED`,
  field `timestamp`, and nothing is written (see the
  [v2 contract](transactions-v2-contract.md#calendar-dates-release-c)).

## Compatibility with existing records

Records written under older rules are never corrected or deleted
automatically. They may hold a zero amount, a date after today, a `""`
description, or a category whose type differs from the transaction type.

- **Unchanged values are not re-validated.** An edit that leaves a legacy
  value as it is succeeds; only new and changed values must follow the
  rules. So a zero amount or a date after today survives an edit of the
  description, and a legacy type/category mismatch survives as long as
  neither `transaction_type` nor `category_id` changes.
- **Sending the current value is not a change.** A client that sends the
  whole form is treated like one that sends only the edited fields: a field
  equal to the stored value counts as unchanged. Equality is by value:
  `amount` in cents (`"0"` equals `"0.00"`), `date` as the calendar day
  (whatever `time_zone` comes with it), ids by number, `description` after trimming and `""`→`null`, the
  assignment as a whole. The same applies to the `category_id` of an
  archived category: sending the transaction's own value keeps the link.
- Changing such a value means meeting the rules: setting a zero amount to
  `"0.00"` again is a no-op, setting it to `"5.00"` is fine, setting a
  positive amount to `"0"` is refused.

## Responses

### Transaction view

One shape for every read and write result: the
[`TransactionViewV2`](transactions-v2-contract.md#transaction-view-v2). It is
built field by field (`toTransactionViewV2`), so an entity column never
reaches the client unless the contract lists it.

`kind` is the only supported way to recognize a starting balance. It comes
from the server's own data (the category's `is_system` flag, which stays
hidden), never from the category name, which is display text and can be
renamed. A client renders an `initial_balance` record read-only and offers
no edit or delete for it.

`version` is the record's concurrency token: the client keeps the value it
read and sends it back as `If-Match: "<version>"` with an edit or a delete
(see [Retries and concurrency](#retries-and-concurrency)).

### `POST /spaces/:spaceId/transactions`

The request and the `201 { transaction }` result are in the
[v2 contract](transactions-v2-contract.md#post-apiv2spacesspaceidtransactions).
`transaction` is the stored record, re-read after the insert, as
`GET /:id` reads it: `amount` has two decimals (`"12.30"` for a request of
`"12.3"`).

The server checks the category (of the space, not the system one, not
archived, of the same type as `transaction_type`), then the assignment.

Takes an optional `Idempotency-Key` header (see
[Idempotency-Key](#idempotency-key)) and an optional `client_operation_id`
(see [Recovering an unfinished create](#recovering-an-unfinished-create));
the mobile client sends both with every create, with the same UUID.

`client_operation_id` is unique in the space for as long as the space
exists, also after the transaction is deleted. A create with an id that was
already used is `409 TRANSACTION_OPERATION_EXISTS` and writes nothing,
whatever its body; it is checked before the category, so a create that
already happened is reported as such even if its category was archived
since. The id is compared case-insensitively.

### History selection

`/feed` and `/count` read the same **selection**: every transaction of the
space with `from_date <= date <= to_date` that matches the filters (and `q`, see
[Search](#search)), in active and archived categories, whoever it is
assigned to unless the `assignment` filter says otherwise.

- **Order:** newest `date` first; records of the same date by the
  server's ordering key, descending: assigned on create in the order of
  the creates, never changed by an edit and never shown to the client. So
  within a day the record created last comes first, and a record moved to
  another date takes its place there by creation. The order is stable
  between requests and has no time of day in it.
- **Starting balance** records are part of the selection, marked
  `kind: 'initial_balance'`. A space with only a starting balance therefore
  has a non-empty history even though its Income is zero; the client
  decides "no history" from `latest` or a count, never from an amount.
- **Filters,** all optional; they combine with each other and with `q`:

| Parameter          | Rule                                                                                                                    | Refused                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `transaction_type` | `income` \| `expense`                                                                                                   | another value: `400 VALIDATION_FAILED`                                                                    |
| `kind`             | `regular` leaves starting balances out, `initial_balance` keeps only them; decided by the system category, never by name | another value: `400 VALIDATION_FAILED`                                                                    |
| `category_id`      | a category of the space, archived allowed                                                                               | malformed: `400 VALIDATION_FAILED`; missing, of another space or the system one: `403 FORBIDDEN_CATEGORY` |
| `assignment`       | see the [v2 contract](transactions-v2-contract.md#history-selection-v2)                                                 | malformed: `400 VALIDATION_FAILED`; an unknown member: `403 FORBIDDEN_MEMBER`                             |

An empty or repeated filter, and any other parameter (`wallet_id`
included), is `400 VALIDATION_FAILED` (see
[`type-contract.md`](type-contract.md#absent-vs-null-vs-empty)). The
statistics drill-down always sends `kind=regular`
([statistics contract](statistics-contract.md#opening-a-breakdown-item)).

### `GET /spaces/:spaceId/transactions/latest`

`200` with the transaction view of the newest record of the space, the first
in the [history order](#history-selection) over all of it, or an empty body
when the space has no transactions. The app uses it to tell an empty
history.

### `GET /spaces/:spaceId/transactions/count`

`200 { count: number }`: the number of records in the
[selection](#history-selection) of `from`, `to`, the filters and the optional
`q`, starting balances included unless `kind=regular` leaves them out. It is
the feed's `summary.count` for the same period, `q` and filters, and reads
no rows, so the period picker counter loads nothing.

- **`from_date` and `to_date`** are required inclusive calendar dates
  (`YYYY-MM-DD`, see [Date](#date)). `from_date` after `to_date` is
  `400 VALIDATION_FAILED`, field `from_date`.
- **`q`** counts the matches of the feed's [Search](#search): trimmed, blank
  means no search, at most 255 characters (longer is
  `400 VALIDATION_FAILED`, field `q`, as is a repeated `q`).

Errors, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`FORBIDDEN_CATEGORY`, `FORBIDDEN_MEMBER`.

### `GET /spaces/:spaceId/transactions/feed`

The one read for every transaction list of the app: the history of a
period, search within it, the statistics drill-down (the same filters), the
latest records on the home screen and the history opened at one record. It
pages with a cursor and returns the totals of the whole selection, computed
by the server.

**Query:**

| Parameter          | Required | Rule                                                                                                                                          |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `from_date`, `to_date` | yes  | Inclusive calendar dates `YYYY-MM-DD`, `1000-01-01` to `9999-12-31`, no default; `from_date` after `to_date` is an error                     |
| `q`                | no       | Search text, see [Search](#search). Trimmed at both ends, inner whitespace kept; empty after trimming means no search. At most 255 characters |
| `limit`            | no       | Page size, an integer `1`–`100`; default `50`                                                                                                 |
| `cursor`           | no       | `next_cursor` or `previous_cursor` of an earlier response to the same query                                                                   |
| `around_id`        | no       | Id of a transaction to open the history at; not with `cursor`                                                                                 |
| `transaction_type` | no       | `income` \| `expense`                                                                                                                         |
| `kind`             | no       | `regular` \| `initial_balance`                                                                                                                |
| `category_id`      | no       | A category of the space, archived allowed; the system one is refused                                                                          |
| `assignment`       | no       | `space`, `unassigned`, `deleted_member` or `member:<user_id>`                                                                                 |

The filters, the selection and its order are those of
[History selection](#history-selection).

`from_date` and `to_date` are compared with the stored `date` directly:
no zone, no instant and no day bounds are involved, so a period means the
same days for every member, wherever they are. The feed takes no
`time_zone`; `time_zone`, `from` and `to` are unknown parameters
(`400 VALIDATION_FAILED`). A period without records is `200` with no
`items`, a zero `summary` and no `day_totals`. `GET /transactions/count`
selects the same records for the same dates, so `summary.count` equals the
count.

Every malformed parameter is `400 VALIDATION_FAILED` with the parameter as
`field`, never corrected: a `q` of 256 characters is refused, not cut; a
`limit` of `0`, `101` or `1.5` is refused, not clamped; a repeated
parameter is refused. `cursor` together with `around_id` is
`400 VALIDATION_FAILED`, field `cursor`.

**Response `200`:** the
[`TransactionFeedV2`](transactions-v2-contract.md#get-apiv2spacesspaceidtransactionsfeed):

```ts
interface TransactionFeed {
  items: TransactionViewV2[]; // at most `limit`, newest first
  page_info: {
    next_cursor: string | null; // older records of the selection; null when there are none
    previous_cursor: string | null; // newer records of the selection; null when there are none
  };
  summary: {
    count: number; // records in the selection, starting balances included
    income: string; // "0.00": regular income of the selection
    expense: string; // "0.00": regular expense of the selection
  };
  day_totals: Array<{
    date: string; // YYYY-MM-DD, the date of at least one record of items
    net: string; // "-12.30": income minus expense of that whole date in the selection
  }>;
}
```

- **Order.** `date` descending, then the ordering key descending: the
  [history order](#history-selection). Every page, also one read with
  `previous_cursor` or `around_id`, lists its items in this order.
- **One snapshot per response.** `items`, `summary` and `day_totals` of a
  response are read in one database snapshot, so they agree with each
  other even while other members write. The snapshot ends with the
  response: a cursor does not pin the database for the rest of the
  scrolling, and there is no frozen copy of the history (see below).
- **Computed in the database.** The count and the sums are aggregated by
  MySQL over the whole selection, never by loading its rows, and in exact
  decimal arithmetic: a sum may exceed the maximum of one amount
  (`"299999999.97"`). Days are the stored dates, grouped as they are.
- **Money** is a string with exactly two decimals; `net` carries a `-`
  when expense exceeds income and is `"0.00"`, never `"-0.00"`, when they
  are equal.
- **`summary`** covers the whole selection, not the page: it is the same
  on every page of one query, unless the data changed between the
  requests. `count` counts starting balances; `income` and `expense` leave
  them out, like the statistics.
- **`day_totals`** has one entry per `date` that has at least one record
  in `items`, in the order of `items`, newest date first, no date twice.
  `net` is income minus expense of **all** the records of that date in the
  selection, also those on other pages, so a date split between two pages
  has the same total on both and it does not change when the next page
  loads. Starting balances are left out of `net`; a date that only has a
  starting balance on the page is listed with `"0.00"`.
- **No records.** An empty selection, or a page past the end, is
  `items: []`, both cursors `null`, `day_totals: []`. `summary` still
  describes the selection (all zeros when it is empty).

#### Search

`q` keeps a record in the selection when its `description` or the name of
its category contains `q` as a substring. A record that matches in both is
listed and counted once. Names of people are not searched: "who" is the
`assignment` filter.

- **Case and accents are ignored**, Cyrillic included: `кофе` finds
  `Кофе`, `елка` finds `Ёлка`, `cafe` finds `Café`. The server compares in
  one fixed collation (`utf8mb4_0900_ai_ci`), whatever the collation of the
  columns or the database default, so the result does not depend on how a
  database was set up.
- **No patterns:** `%`, `_` and `!` (the server's escape character) are
  plain characters, so `100%` finds only text with `100%` in it.
- **Archived categories** are searched by their stored names.
- The system category's name is searched like any other: `q=Initial`
  finds the starting balances. The amount is not searched.

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
- A cursor is at most 256 characters and carries its format version
  (`2` since Release C); a cursor of a format the server no longer reads,
  such as one issued before Release C, is refused like any malformed one,
  and the client reloads the first page.
- A cursor belongs to its query: it is accepted only with the same
  `from_date`, `to_date`, `q` (after trimming) and filters, `assignment`
  included, it was returned for. `limit` may change between pages. A cursor
  of another query, of the retired v1 feed, or one that is not a cursor at
  all, is `400 VALIDATION_FAILED`, field `cursor`: the client then reloads
  the first page.

Pages are read at different moments, each from the database as it is
then; the feed keeps no history session between requests. Records written
between two requests are not shifted into or out of the loaded pages. A
record created or moved above the first loaded page is reached by
reloading the first page (pull to refresh). A record edited between two
requests can be listed on both pages, or on neither if its date moved
across the loaded part. The client therefore keys records by `id` and keeps
the copy of the latest response, and takes `summary` and the `day_totals`
of a date from the latest response that carries them. After a pull to
refresh, or whenever it needs figures that agree across the whole list, the
client starts a new load from the first page.

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
period that contains the record's `date`, normally its month.

#### Screens

The screens and their requests are in the
[v2 contract](transactions-v2-contract.md#screens). The home screen's latest
records are `limit=5`, `from_date=1000-01-01`, `to_date=9999-12-31`; only
`items` are used.

**Errors**, in check order: `VALIDATION_FAILED`, `FORBIDDEN_SPACE`,
`FORBIDDEN_CATEGORY`, `FORBIDDEN_MEMBER`, then `TRANSACTION_NOT_FOUND` and
`TRANSACTION_NOT_IN_FEED` for `around_id`.

**Relation to the other reads.** For the same `from`, `to`, `q` and
filters, `summary.count` equals `GET /transactions/count`, and the items of
all the pages together are that many records, each once, in the history
order. `GET /transactions/latest` is the first item of the feed over the
whole stored range without filters.

### `GET /spaces/:spaceId/transactions/operations/:operationId`

What became of the create sent with `client_operation_id: operationId`
([shape](transactions-v2-contract.md#get-apiv2spacesspaceidtransactionsoperationsoperationid)):

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
the answer is read in one snapshot. The creates of the retired v1 API are
found the same way. Records created without `client_operation_id` (older
clients, starting balances) cannot be looked up.

### `GET /spaces/:spaceId/transactions/:transactionId`

`200` with the transaction view of any transaction of the space: regular or
starting balance, on an active or archived category. It is the same object
the feed returns for that transaction.

Errors: `FORBIDDEN_SPACE` (checked first, so a non-member learns nothing
about the id), `TRANSACTION_NOT_FOUND`.

### `PATCH /spaces/:spaceId/transactions/:transactionId`

Headers: `If-Match: "<version>"`, required: the version the client read.
Without it the edit is refused with `428 TRANSACTION_VERSION_REQUIRED`.
`Idempotency-Key` is optional.

Request: any subset of the create fields but `client_operation_id`
([shape](transactions-v2-contract.md#patch-apiv2spacesspaceidtransactionstransactionid)).

| Field value                                                | Meaning                                             |
| ---------------------------------------------------------- | --------------------------------------------------- |
| absent                                                     | keep the current value                              |
| equal to the current value                                 | keep the current value (no re-validation)           |
| `null` for `description`                                   | clear the description                               |
| `null` for any other field                                 | `400 VALIDATION_FAILED`, `<field> must not be null` |
| unknown field (`id`, `space_id`, `kind`, `wallet_id`, ...) | `400 VALIDATION_FAILED`                             |
| empty body                                                 | no-op, `200` with the current state                 |

The server merges the request into the current record and validates the
result:

| Check                                                       | Applies when                                | Error                              |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| The transaction is not a starting balance                   | always                                      | `400 TRANSACTION_IS_SYSTEM`        |
| `If-Match` equals the stored version                        | always                                      | `409 TRANSACTION_VERSION_CONFLICT` |
| Amount `0.01`–`99999999.99`, two decimals                   | `amount` changes                            | `400 VALIDATION_FAILED`            |
| Date not after today in `time_zone`                         | `date` changes                              | `400 VALIDATION_FAILED`            |
| Category exists in the space and is not the system one      | `category_id` changes                       | `403 FORBIDDEN_CATEGORY`           |
| Category is not archived                                    | `category_id` changes                       | `400 CATEGORY_ARCHIVED`            |
| Resulting category type equals resulting `transaction_type` | `transaction_type` or `category_id` changes | `400 CATEGORY_TYPE_MISMATCH`       |
| A member assignment names a current member                  | `assignment` changes                        | `400 ASSIGNEE_NOT_MEMBER`          |

Request-shape errors (types, formats, description length, `null`s, unknown
fields, a malformed `If-Match` or `Idempotency-Key`) come before the record
is loaded, so a malformed request to a missing transaction is a `400`. Then
`TRANSACTION_VERSION_REQUIRED`, `FORBIDDEN_SPACE`, `IDEMPOTENCY_KEY_REUSED`,
`TRANSACTION_NOT_FOUND`, and the checks above in table order. Amount and
date rules depend on the stored value, so they run after the record is
loaded. A failed edit changes nothing.

`200 { transaction }`: the stored state after the edit. A no-op edit does
not bump `version`.

### `DELETE /spaces/:spaceId/transactions/:transactionId`

Deletes a regular transaction, also one in an archived category. `200`
with the body `true`. The record is removed; there is no compensating
"reverse" transaction.

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
| Starting balance          | `400 TRANSACTION_IS_SYSTEM`        | not offered by the UI                                    |

With an `Idempotency-Key`, a repeat of a delete that succeeded answers
`200 true` again, so "already gone" then only means another member deleted
it. A repeat still checks access first.

**Undo of a create** is this same delete of the record the `POST` created,
with `If-Match` set to `transaction.version` from the `POST` result (`1`).
If another member, or another device, edited the record in between, undo
gets `409` and deletes nothing; the client offers to open `GET /:id`
instead of removing a version the user has not seen. Undo follows every
rule of an ordinary delete.

## Retries and concurrency

Two members of a shared space, or one user on two devices, can change the
same transaction at the same time, and a phone can lose the response to a
write the server did commit. Disabling a button on the phone protects
against neither, so the server guarantees the following.

### One DB transaction per write

Every transaction write (`POST`, `PATCH`, `DELETE`) runs as one MySQL
transaction (`READ COMMITTED`) that does, in this order:

1. lock the acting member's `space_members` row (shared) — the access check;
   a write that sets a member assignment locks the assignee's row with it,
   both in ascending id order;
2. lock the `spaces` row (shared);
3. claim the `Idempotency-Key`, if sent;
4. lock the transaction row (exclusive), read it and check its version —
   `PATCH`, `DELETE`;
5. lock the category rows (shared);
6. check the domain rules, write, record the `client_operation_id` (a create
   with a used id waits here for the other create, then is refused), store
   the idempotent result.

Either all of it commits or nothing does. Every read after a lock sees the
latest committed state, so a membership removed or a category archived by a
request that committed first is seen and refused.

**Lock order.** Every write that takes more than one of these locks takes
them in the order above, so two writes never wait on each other crosswise:

| Operation                                                                   | Locks, in order                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Transaction `POST` / `PATCH` / `DELETE`                                     | member rows (S, ascending id: the actor's and a newly assigned member's), space (S), key, transaction (X), categories (S), operation row |
| Category create, edit, archive, delete, reorder; limit create, edit, delete | member (S), space (X), then their own rows                                                                          |
| Space create                                                                | key (with `Idempotency-Key`), then the new rows only                                                                |
| Space delete, leave, member removal                                         | member rows (X, ascending id), space (X), then the set is checked; a deleted space's transactions (X); see below   |
| Invitation create                                                           | member (S), space (X), the new invitation                                                                           |
| Invitation resend                                                           | member (S), space (X), invitation (X)                                                                               |
| Invitation revoke                                                           | member (S), invitation (X)                                                                                          |
| Invitation accept                                                           | space (X), invitation (X), the new member row; the recipient has no member row yet                                  |
| Invitation email attempt (background)                                       | invitation (X), one conditional update to claim and one to record the result; nothing held meanwhile                |
| Password reset request                                                      | user (S) if the email has one, password reset challenge (X)                                                         |
| Password reset verify                                                       | user (S) if the email has one, password reset challenge (X)                                                         |
| Password reset complete                                                     | user (X), password reset challenge (X)                                                                              |
| Login (token issue)                                                         | user (S)                                                                                                            |
| Category catalog migration (maintenance)                                    | spaces (X, ascending id), categories (X), limit links (X), then the rows it rewrites                                |
| TestFlight account provisioning (maintenance)                               | the new rows only; a concurrent run waits on the user's email key                                                   |

(S = shared, X = exclusive.) Consequences:

- Transaction writes in one space run side by side; two writes of one
  record queue on its row.
- Category and limit changes take the space row exclusively, so they wait
  for in-flight transaction writes and the other way round: a category
  deleted while a transaction is being added to it is archived, not removed.
- Category and limit writes also hold the acting member's row until commit.
  Removal cannot overtake an authorized write; requests after removal are
  refused. Reordering validates and writes inside the same transaction,
  serialized with category archival and deletion.
- A write assigning a record to a member holds that member's row (shared)
  until it commits. Removing the member locks every member row of the space
  exclusively, so of the two exactly one goes first: the removal waits and
  the record keeps its now former member, or the write sees the membership
  gone and is refused with `ASSIGNEE_NOT_MEMBER`. Both lock member rows
  before the space, in ascending id order.
- Invitation acceptance starts at the space row because the recipient
  has no member row yet; see
  [the invitations contract](invitations-contract.md#lock-order).
- Space deletion, leaving and member removal lock every member row of the
  space and the actor's member rows in other spaces (exclusive, ascending
  id), then the space (exclusive), and read that set again. An acceptance
  adds a member under the space lock alone, and no write locks a member row
  after a space, so a set that changed in between rolls the transaction
  back and runs it again with the new set, up to three times before
  answering `500`. Ownership, the successor of a leaving owner (earliest
  `created_at`, then lowest id), whether the owner is the last member, and
  the actor's space count for `SPACE_LAST_REMAINING` are all read under
  these locks, and the resulting writes commit with them. Deleting a space
  removes its transactions before the space itself: they reference its
  categories, which the space's deletion cascades to. A transaction write
  of that space waits for the space lock and is then refused.
- Login signs its token under the user's shared lock after checking that
  the password and `auth_version` are still the ones it verified. A
  password reset holds the user exclusively, so a login racing it either
  gets a token that the reset then revokes, or is refused.
- MySQL may still detect a deadlock in rare cases (for example, two waiting
  repeats of one key after the first attempt failed). The server retries
  the whole unit up to three times before answering `500`.

### Maintenance writes

Three writes run outside the API, from the backend image, as deploy steps:

- **`ReplaceCategoryCatalog1790900000000`** (migration).
  - Runs in one transaction with foreign keys on. Earlier migrations in the
    same run may have committed DDL, so it starts a fresh transaction.
  - Locks the spaces it rewrites (exclusive, ascending id), then their
    ordinary categories, then every limit link in the database. It checks
    for limit conflicts before writing anything.
  - Then it renames, inserts and deletes categories and rewrites the limit
    links. It moves transactions with `version + 1`.
  - It takes the space row first, like category writes, and never takes a
    member row, so it fits the order above. It still runs with the API
    stopped: a client's queued write must not refer to a category it
    deletes (see [`deployment.md`](deployment.md#rolling-out-the-starter-category-catalog)).
- **`DropWallets1791400000000`** (migration). Schema changes only, in a
  write pause: it reads the records to check that each one's space is its
  wallet's, then drops the wallet column of transactions and the `wallets`
  table (see [`deployment.md`](deployment.md#rolling-out-the-removal-of-wallets)).
- **TestFlight account provisioning** (`seed-testflight.js`).
  - Reads the user by email without a lock. An existing account is only
    checked, never written.
  - Otherwise it inserts the user, space, membership, categories, sample
    transactions and limit in one `runWriteTransaction`. It locks no
    existing row.
  - Of two concurrent runs, the second waits on the unique email key. It
    then fails with a duplicate key, rolls back, and checks the account the
    first one created.

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
  (`transactions.v2.create`, `transactions.v2.update`,
  `transactions.v2.delete`): the same key from another user, in another
  space or for another operation is a different key, also a key the retired
  v1 API stored for its own operations. Keys are compared byte for byte.
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
Only `client_operation_id` identifies the create. The pending writes an
older app build kept on the device are resolved as described in
[the v2 contract](transactions-v2-contract.md#recovering-writes-across-the-upgrade).

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
`GET /limits` reads the limits and their spending in one database snapshot:
a write committed during the request is in none of its figures or in all of
them.

`GET /categories` likewise reads category state, transaction counts and
limit links from one snapshot. Concurrent archival cannot return an active
category combined with the link removals of the archived state.

| Figure                                    | Starting balance | Regular transactions                               |
| ----------------------------------------- | ---------------- | -------------------------------------------------- |
| Feed `items`, `summary.count`, `/count`   | included         | dated `from_date`..`to_date`, by `q` and filters   |
| Feed `summary.income` / `summary.expense` | excluded         | dated `from_date`..`to_date`, by `q` and filters   |
| Feed `day_totals` `net`                   | excluded         | of that date, by `q` and the filters               |
| Statistics Income / Expense / Net         | excluded         | dated up to `actual_end_date`, by type             |
| Limits `spent`                            | excluded         | expenses dated in the month, by category           |
| Category `transaction_count`              | not shown        | all, whatever their date                           |

Changing a record's type, category, amount, date or assignment moves it
between Income and Expense, categories, limits, periods and assignment
groups accordingly. A day's financial total in the history is the feed's
`day_totals`, computed by the server; the client does not add up loaded
rows.

### Limits period

`GET /limits?time_zone=<IANA>` counts `spent` over the current calendar
month in that zone and returns the month it counted:

```ts
interface LimitsSummary {
  period: {
    time_zone: string; // canonical IANA name
    start_date: string; // first day of the month, YYYY-MM-DD
    end_date: string; // last day of the month
  };
  // LimitView: id, name, amount, spent, in_percent, categories
  total: LimitView | null;
  categories: LimitView[];
  over_allocation: { category_total: number; difference: number } | null;
}
```

`spent` counts the expenses dated `start_date` to `end_date`; the zone
only decides which month is current. The mobile client sends the device's
zone, as for statistics, and every screen showing limit spending takes the
month from `period`; a history request for "this month's" figures uses
`from_date=period.start_date&to_date=period.end_date`. A fixed offset (`+03:00`) or an unknown zone is
`400 VALIDATION_FAILED`, field `time_zone`. Without `time_zone` the month is
the server's.

The monthly total limit (`limit_type: 'others'`, no categories) counts
**every** expense of the month, those of categories with their own limit
included, whoever they are assigned to; it is not a budget for the
categories left without one. A category limit counts the expenses of its
categories.

### Comparing figures

Figures agree when they are asked for the same thing: the same filters and
the same dates. Compare a statistics block with the history using its
`period.start_date` and `actual_end_date` (not `end_date`: a current
period stops at the date of `as_of`), and the limits with the history
using the limits `period`. A date means the same day for every reader, so
the zone of the reader never moves a record between days.

## Errors

Every error body carries a stable `code` next to the existing fields; the
client branches on `statusCode` and `code`, never on `message`, which is
English display text and may change.

```json
{
  "timestamp": "2026-10-05T10:00:00.000Z",
  "path": "/api/v2/spaces/1/transactions/…",
  "statusCode": 400,
  "requestId": "…",
  "code": "CATEGORY_TYPE_MISMATCH",
  "message": "The category type does not match the transaction type"
}
```

| Status | `code`                            | When                                                                         |
| ------ | --------------------------------- | ---------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`               | Request shape, field rule or header; `message` is `[{ field, error }]`       |
| 400    | `TRANSACTION_IS_SYSTEM`           | `PATCH`/`DELETE` of a starting balance                                       |
| 400    | `CATEGORY_ARCHIVED`               | An archived category chosen on create, or a different one on edit            |
| 400    | `CATEGORY_TYPE_MISMATCH`          | The resulting category type differs from the transaction type               |
| 400    | `ASSIGNEE_NOT_MEMBER`             | A new member assignment names a user who is not a member now                 |
| 400    | `BAD_REQUEST`                     | A non-numeric `:spaceId`                                                     |
| 401    | `UNAUTHORIZED`                    | Missing, invalid or revoked token                                            |
| 403    | `FORBIDDEN_SPACE`                 | Not a member, or no such space                                               |
| 403    | `FORBIDDEN_CATEGORY`              | No such category in the space, or the system category                        |
| 403    | `FORBIDDEN_MEMBER`                | `assignment=member:<id>` names a user unknown to the space                   |
| 404    | `TRANSACTION_NOT_FOUND`           | No such transaction in the space, or a malformed id                          |
| 404    | `TRANSACTION_OPERATION_NOT_FOUND` | No create with this `client_operation_id` committed in the space             |
| 404    | `TRANSACTION_NOT_IN_FEED`         | The feed's `around_id` is outside the period, the search or a filter         |
| 409    | `TRANSACTION_VERSION_CONFLICT`    | `If-Match` differs from the stored version                                   |
| 409    | `IDEMPOTENCY_KEY_REUSED`          | The `Idempotency-Key` was used for a different request                       |
| 409    | `TRANSACTION_OPERATION_EXISTS`    | The `client_operation_id` was already used in the space                      |
| 410    | `LEGACY_API_RETIRED`              | A retired `/api/v1` transaction, statistics or wallet route; the app updates |
| 428    | `TRANSACTION_VERSION_REQUIRED`    | `PATCH` or `DELETE` without `If-Match`                                       |
| 429    | `TOO_MANY_REQUESTS`               | Rate limit                                                                   |
| 500    | `INTERNAL_SERVER_ERROR`           | Unexpected server failure; details only in the log                           |

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
`path`, `statusCode` and `requestId`. More examples, with authors and
assignments, are in the [v2 contract](transactions-v2-contract.md).

### Create, with a retry after a lost response

```http
POST /api/v2/spaces/1/transactions
Idempotency-Key: 0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70

{ "category_id": 12, "transaction_type": "expense", "amount": "12.3",
  "date": "2026-09-15", "time_zone": "Europe/Moscow", "description": "  Lunch ",
  "assignment": { "kind": "space" },
  "client_operation_id": "0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70" }
```

```http
201
{ "transaction": { "id": "9b1d…", "kind": "regular", "transaction_type": "expense",
                   "amount": "12.30", "date": "2026-09-15",
                   "description": "Lunch", "version": 1,
                   "category": { "id": 12, "name": "Groceries", "is_archived": false, … },
                   "author": { … }, "assignment": { "kind": "space", … } } }
```

The response is lost; the app sends the same request with the same key and
gets the same `201` body. No second transaction is created. Sending the key
with another body is `409 IDEMPOTENCY_KEY_REUSED`.

### Create, recovered after days offline

The same create was sent three days ago and its answer was lost. The key has
expired, so the app looks the operation up instead of resending:

```http
GET /api/v2/spaces/1/transactions/operations/0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70

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
PATCH /api/v2/spaces/1/transactions/9b1d…
If-Match: "1"

{ "amount": "20" }
```

```http
200
{ "transaction": { "id": "9b1d…", "amount": "20.00", "version": 2, … } }
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
DELETE /api/v2/spaces/1/transactions/9b1d…
If-Match: "1"
Idempotency-Key: 4c2a…
```

`200 true`. Repeated with the same key, `200 true` again; without a key,
`404 TRANSACTION_NOT_FOUND`, which the client also treats as done. If
another member edited the record first, `409 TRANSACTION_VERSION_CONFLICT`
and nothing is deleted. Deleting a starting balance:

```http
400
{ "code": "TRANSACTION_IS_SYSTEM", "message": "The initial balance cannot be edited or deleted" }
```

### History, count and limits for this month

```http
GET /api/v1/spaces/1/limits?time_zone=Europe/Moscow

200 { "period": { "time_zone": "Europe/Moscow", "start_date": "2026-10-01",
                  "end_date": "2026-10-31" },
      "total": { "id": 3, "amount": "1000.00", "spent": 20, "in_percent": 2, … }, … }

GET /api/v2/spaces/1/transactions/count?from_date=2026-10-01&to_date=2026-10-31

200 { "count": 5 }
```

### Feed: first page, next page, search, opening at a record

The October history, 50 per page:

```http
GET /api/v2/spaces/1/transactions/feed?from_date=2026-10-01&to_date=2026-10-31

200
{ "items": [
    { "id": "f3a0…", "kind": "regular", "transaction_type": "expense", "amount": "12.30",
      "date": "2026-10-12", "version": 1, … },
    …,
    { "id": "07c4…", "kind": "regular", "transaction_type": "expense", "amount": "4.00",
      "date": "2026-10-03", "version": 1, … } ],
  "page_info": { "next_cursor": "eyJ2IjoyLC…", "previous_cursor": null },
  "summary": { "count": 73, "income": "2500.00", "expense": "1184.45" },
  "day_totals": [ { "date": "2026-10-12", "net": "-12.30" },
                  …,
                  { "date": "2026-10-03", "net": "-31.50" } ] }
```

The page ends inside October 3: `-31.50` is the whole day, also the records
of October 3 that are not loaded yet. Scrolling on:

```http
GET /api/v2/spaces/1/transactions/feed?from_date=2026-10-01&to_date=2026-10-31&cursor=eyJ2IjoyLC…

200
{ "items": [ { "id": "05d1…", "date": "2026-10-03", … }, …,
             { "id": "c9e2…", "kind": "initial_balance", "transaction_type": "income",
               "amount": "100.00", "date": "2026-10-01", … } ],
  "page_info": { "next_cursor": null, "previous_cursor": "eyJ2IjoyLC…" },
  "summary": { "count": 73, "income": "2500.00", "expense": "1184.45" },
  "day_totals": [ { "date": "2026-10-03", "net": "-31.50" }, …,
                  { "date": "2026-10-01", "net": "0.00" } ] }
```

October 3 has the same total as on the first page. October 1 only has a
starting balance, so its `net` is `"0.00"`; the starting balance is counted
in `count` but not in `income`. `next_cursor: null`: the history ends here.

A search with no match, `q` sent as `" coffee  "` (trimmed to `"coffee"`):

```http
GET /api/v2/spaces/1/transactions/feed?from_date=2026-10-01&to_date=2026-10-31&q=%20coffee%20%20

200
{ "items": [],
  "page_info": { "next_cursor": null, "previous_cursor": null },
  "summary": { "count": 0, "income": "0.00", "expense": "0.00" },
  "day_totals": [] }
```

Opening the history at a record from the home screen, 5 records per page
to keep the example short:

```http
GET /api/v2/spaces/1/transactions/feed?from_date=2026-10-01&to_date=2026-10-31&limit=5&around_id=8a61…

200
{ "items": [ { "id": "b2f7…", "date": "2026-10-09", … },
             { "id": "41aa…", "date": "2026-10-09", … },
             { "id": "8a61…", "date": "2026-10-09", … },
             { "id": "e05c…", "date": "2026-10-08", … },
             { "id": "6d13…", "date": "2026-10-08", … } ],
  "page_info": { "next_cursor": "eyJ2IjoyLC…", "previous_cursor": "eyJ2IjoyLC…" },
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

## Mobile checklist

- Read the transaction view everywhere: `kind` decides whether a record is
  editable (`initial_balance` is read-only), `category.is_archived` marks an
  archived category, `author` and `assignment` say who entered it and whom
  it is for.
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
- Send the picked calendar `date` with the device's IANA `time_zone` on
  every create and every edit of the date; send history bounds as
  `from_date`/`to_date`; pass the device's zone to statistics and limits;
  take "this month" from the limits `period`. Never convert a stored
  `date` with a zone.
- Edit with `PATCH`, sending only what changed or the whole form; leave
  `category_id` out (or send the current id) to keep an archived category.
- Use `GET /transactions/count` for the calendar counter, with the open
  search's `q` so that it counts the matches; decide "no history" from
  `latest` or the count, never from Income being zero.
- Load every transaction list from `GET /transactions/feed`: store cursors
  as opaque strings, key records by `id`, and show `summary` and
  `day_totals` as the server returns them instead of adding up loaded rows.
- Branch on `statusCode` and `code`, never on `message`.
